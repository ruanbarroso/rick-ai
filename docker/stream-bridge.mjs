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
import { writeSync } from "node:fs";

/**
 * Write a line to stdout using synchronous fs.writeSync(fd=1).
 * This bypasses Node.js stream buffering which can stall inside
 * `docker exec -i` pipes, causing events to never reach the main container.
 */
function writeLine(line) {
  writeSync(1, line + "\n");
}

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
        const { events, lastEventId: serverLastId, state } = await res.json();
        if (Array.isArray(events)) {
          for (const evt of events) {
            if (evt.data) {
              // Include the event ID so the main container can track sync progress.
              // Injected as _eventId — handleAgentOutput extracts it and updates
              // _lastSyncedEventId without re-fetching events after a bridge reconnect.
              const payload = typeof evt.id === "number"
                ? { ...evt.data, _eventId: evt.id }
                : evt.data;
              writeLine(JSON.stringify(payload));
            }
            if (typeof evt.id === "number" && evt.id > lastEventId) {
              lastEventId = evt.id;
            }
          }
        }
        if (typeof serverLastId === "number") lastEventId = Math.max(lastEventId, serverLastId);
        // Use agent state from /events response for adaptive polling (no separate /health call needed)
        if (typeof state === "string") {
          idleState = state === "waiting_user" || state === "done" || state === "ready";
        }
      }
    } catch {
      // Agent not reachable — it may have exited or still starting up.
    }

    const interval = idleState ? POLL_INTERVAL_IDLE_MS : POLL_INTERVAL_MS;
    await new Promise((r) => setTimeout(r, interval));
  }
}

pollEvents().catch((err) => {
  process.stderr.write(`[bridge] Poll loop crashed: ${err?.message}\n`);
  process.exit(1);
});
