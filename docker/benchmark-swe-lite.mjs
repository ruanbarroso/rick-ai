#!/usr/bin/env node
/**
 * benchmark-swe-lite.mjs
 *
 * Lightweight benchmark harness for sub-agent autonomy.
 * Runs a list of tasks against docker/agent.mjs and collects per-turn metrics.
 *
 * Usage:
 *   node docker/benchmark-swe-lite.mjs docker/benchmark-tasks.example.json
 */

import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

function usage() {
  console.log("Usage: node docker/benchmark-swe-lite.mjs <tasks.json>");
}

function loadTasks(filePath) {
  const raw = readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("tasks.json deve ser um array");
  return parsed;
}

async function runTask(task) {
  return await new Promise((resolveTask) => {
    const child = spawn("node", ["docker/agent.mjs"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
      cwd: process.cwd(),
    });

    const startedAt = Date.now();
    let buffer = "";
    let finalText = "";
    let waitingSeen = false;
    let toolCalls = 0;
    let metrics = null;

    const finish = (status, reason = "") => {
      if (!child.killed) child.kill();
      resolveTask({
        id: task.id,
        status,
        reason,
        durationMs: Date.now() - startedAt,
        toolCalls,
        finalText,
        metrics,
      });
    };

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;

        let msg;
        try { msg = JSON.parse(line); } catch { continue; }

        if (msg.type === "tool_call" && msg.event === "start") toolCalls += 1;
        if (msg.type === "message") finalText = msg.text || finalText;
        if (msg.type === "turn_metrics") metrics = msg;
        if (msg.type === "error") {
          finish("error", msg.message || "unknown error");
          return;
        }
        if (msg.type === "waiting_user") {
          waitingSeen = true;
          const expected = task?.expectRegex ? new RegExp(task.expectRegex, "i") : null;
          const ok = expected ? expected.test(finalText || "") : true;
          finish(ok ? "passed" : "failed", ok ? "" : "expectRegex nao bateu na resposta final");
          return;
        }
      }
    });

    child.stderr.on("data", () => {
      // Ignore debug noise; benchmark status comes from stdout messages.
    });

    child.on("exit", (code) => {
      if (!waitingSeen) {
        finish("error", `agent encerrou sem waiting_user (code=${code})`);
      }
    });

    // Start task after process boot
    child.stdin.write(JSON.stringify({ type: "message", text: task.prompt, model: task.model || "gpt-5.4" }) + "\n");

    const timeoutMs = task.timeoutMs || 180_000;
    setTimeout(() => {
      finish("timeout", `tempo limite ${timeoutMs}ms`);
    }, timeoutMs);
  });
}

async function main() {
  const taskFile = process.argv[2];
  if (!taskFile) {
    usage();
    process.exit(1);
  }

  const tasks = loadTasks(resolve(taskFile));
  const results = [];
  for (const task of tasks) {
    // eslint-disable-next-line no-console
    console.log(`Running: ${task.id}`);
    const result = await runTask(task);
    results.push(result);
  }

  const passed = results.filter((r) => r.status === "passed").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const errors = results.filter((r) => r.status === "error" || r.status === "timeout").length;

  // eslint-disable-next-line no-console
  console.log("\n=== SWE-lite benchmark ===");
  // eslint-disable-next-line no-console
  console.log(`Total: ${results.length} | Passed: ${passed} | Failed: ${failed} | Errors/Timeout: ${errors}`);
  for (const r of results) {
    // eslint-disable-next-line no-console
    console.log(`- ${r.id}: ${r.status} (${r.durationMs}ms, tools=${r.toolCalls})${r.reason ? ` - ${r.reason}` : ""}`);
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
