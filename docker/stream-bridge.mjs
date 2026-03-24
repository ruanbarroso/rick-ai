#!/usr/bin/env node

/**
 * Stream bridge: connects docker exec stdin/stdout to the agent's HTTP control server.
 *
 * - Reads NDJSON lines from stdin → POST /command on localhost:3000
 * - Long-polls GET /events?after=N&wait=30 on localhost:3000 → writes NDJSON to stdout
 *
 * Uses long-poll instead of interval-based polling for instant event delivery.
 * The agent's /events endpoint blocks until new events arrive or the wait timeout expires.
 */

import { createInterface } from "node:readline";
import { writeSync } from "node:fs";

/**
 * Write a line to stdout using synchronous fs.writeSync(fd=1).
 * This bypasses Node.js stream buffering which can stall inside
 * `docker exec` pipes, causing events to never reach the main container.
 */
function writeLine(line) {
  writeSync(1, line + "\n");
}

const AGENT_URL = "http://localhost:3000";
const LONG_POLL_WAIT = 30; // seconds — agent holds the request until events arrive or timeout
const RETRY_DELAY_MS = 1000; // retry delay when agent is not reachable

let lastEventId = 0;
let polling = true;

// ==================== STDIN → POST /command ====================

if (process.stdin.readable && !process.stdin.destroyed) {
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
    // Stdin may close immediately when launched without -i.
    // Keep polling — the bridge must stream events even without command input.
  });
}

// ==================== GET /events (long-poll) → stdout ====================

const startAfter = parseInt(process.argv[2] || "0", 10) || 0;
lastEventId = startAfter;

async function pollEvents() {
  while (polling) {
    try {
      // Long-poll: the agent holds this request until new events arrive
      // or the wait timeout expires (30s). No more 500ms delay.
      const res = await fetch(
        `${AGENT_URL}/events?after=${lastEventId}&wait=${LONG_POLL_WAIT}`,
        { signal: AbortSignal.timeout((LONG_POLL_WAIT + 5) * 1000) }
      );
      if (res.ok) {
        const { events, lastEventId: serverLastId } = await res.json();

        // Detect event store reset: if server's lastEventId is less than our
        // cursor, the SQLite DB was nuked and recreated (Level 2 recovery).
        // Reset to 0 to re-fetch all events from the new DB.
        if (typeof serverLastId === "number" && serverLastId < lastEventId && (!events || events.length === 0)) {
          process.stderr.write(`[bridge] Event store reset detected (server=${serverLastId} < cursor=${lastEventId}). Resetting to 0.\n`);
          lastEventId = 0;
          continue;
        }

        if (Array.isArray(events)) {
          for (const evt of events) {
            if (evt.data) {
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
        // No delay needed — immediately long-poll again
        continue;
      }
    } catch {
      // Agent not reachable — retry after short delay
    }
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  }
}

pollEvents().catch((err) => {
  process.stderr.write(`[bridge] Poll loop crashed: ${err?.message}\n`);
  process.exit(1);
});
