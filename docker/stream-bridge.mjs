#!/usr/bin/env node

/**
 * Stream bridge: connects docker exec stdin/stdout to the agent's HTTP control server.
 *
 * - Reads NDJSON lines from stdin → POST /command on localhost:3000
 * - Polls GET /events?after=N on localhost:3000 → writes NDJSON to stdout
 *
 * This allows the main container to maintain the existing NDJSON protocol
 * over docker exec, while the agent runs as a resident process (PID 1).
 */

import { createInterface } from "node:readline";

const AGENT_URL = "http://localhost:3000";
const POLL_INTERVAL_MS = 500;  // 500ms polling — good balance between latency and load
const POLL_INTERVAL_IDLE_MS = 2000; // Slow down when agent is idle (waiting_user/done)

let lastEventId = 0;
let polling = true;
let idleState = false;

// ==================== STDIN → POST /command ====================

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", async (line) => {
  if (!line.trim()) return;
  try {
    await fetch(`${AGENT_URL}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: line,
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    process.stderr.write(`[bridge] Failed to forward command: ${err?.message}\n`);
  }
});

rl.on("close", () => {
  // Main container stdin closed — stop polling and exit gracefully
  polling = false;
  process.exit(0);
});

// ==================== GET /events → stdout ====================

// On startup, get the initial lastEventId passed as CLI arg (if any).
// This lets the main container resume from where it left off.
const startAfter = parseInt(process.argv[2] || "0", 10) || 0;
lastEventId = startAfter;

async function pollEvents() {
  while (polling) {
    try {
      const res = await fetch(`${AGENT_URL}/events?after=${lastEventId}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const { events, lastEventId: serverLastId } = await res.json();
        if (Array.isArray(events)) {
          for (const evt of events) {
            if (evt.data) {
              process.stdout.write(`${JSON.stringify(evt.data)}\n`);
            }
            if (typeof evt.id === "number" && evt.id > lastEventId) {
              lastEventId = evt.id;
            }
          }
        }
        // Track idle state for adaptive polling
        if (typeof serverLastId === "number") lastEventId = Math.max(lastEventId, serverLastId);
      }
    } catch {
      // Agent not reachable — it may have exited. Check if container is still alive.
    }

    // Check agent state for adaptive polling interval
    try {
      const healthRes = await fetch(`${AGENT_URL}/health`, { signal: AbortSignal.timeout(2000) });
      if (healthRes.ok) {
        const health = await healthRes.json();
        idleState = health.state === "waiting_user" || health.state === "done" || health.state === "ready";
      }
    } catch {
      // Ignore health check failures during polling
    }

    const interval = idleState ? POLL_INTERVAL_IDLE_MS : POLL_INTERVAL_MS;
    await new Promise((r) => setTimeout(r, interval));
  }
}

pollEvents().catch((err) => {
  process.stderr.write(`[bridge] Poll loop crashed: ${err?.message}\n`);
  process.exit(1);
});
