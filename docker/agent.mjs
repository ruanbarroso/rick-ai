#!/usr/bin/env node

import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { mkdir, writeFile, rm, access, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";

const MODEL_MAP = {
  "claude-opus-4-6": "anthropic/claude-opus-4-6",
  "gpt-5.4": "openai/gpt-5.4",
  "gemini-3.1-pro": "google/gemini-3.1-pro-preview",
};

const DEFAULT_MODEL_ID = "claude-opus-4-6";
const HISTORY_MAX_MESSAGES = 120;
const HISTORY_MAX_CHARS = 12_000;       // Total character budget for the prelude text
const HISTORY_MSG_MAX_CHARS = 2_000;    // Max chars per individual message (truncate code diffs)

const CONTROL_HTTP_PORT = 3000;

/** Strip ANSI escape sequences from a string (colors, cursor movement, etc.) */
function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

// ==================== LOCAL EVENT STORE ====================
// Durable outbox: all events are persisted locally BEFORE being sent to stdout.
// When the main process reconnects after a restart, it can fetch missed events.

const stateDbPath = "/app/state.db";
const stateDb = new DatabaseSync(stateDbPath);
stateDb.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`);
stateDb.exec(`
  CREATE TABLE IF NOT EXISTS state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);

const stmtInsertEvent = stateDb.prepare("INSERT INTO events (type, data, created_at) VALUES (?, ?, ?)");
const stmtGetEvents = stateDb.prepare("SELECT id, type, data, created_at FROM events WHERE id > ? ORDER BY id ASC");
const stmtGetState = stateDb.prepare("SELECT value FROM state WHERE key = ?");
const stmtSetState = stateDb.prepare("INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)");

function setState(key, value) {
  stmtSetState.run(key, String(value));
}

function getState(key) {
  const row = stmtGetState.get(key);
  return row ? row.value : null;
}

function getLastEventId() {
  const row = stateDb.prepare("SELECT MAX(id) AS last_id FROM events").get();
  return row?.last_id ?? 0;
}

/** Pending long-poll waiters — resolved when new events are emitted. */
const eventWaiters = new Set();

/** Wake all long-poll waiters (called from emit). */
function notifyEventWaiters() {
  for (const resolve of eventWaiters) {
    resolve();
  }
  eventWaiters.clear();
}

/** Flag: true when stdin pipe is broken (main container restarted). */
let stdinClosed = false;
/** Flag: true when stdout pipe is broken. */
let stdoutBroken = false;

let currentGeneration = 0;
let processingGeneration = 0;
let runChain = Promise.resolve();
let activeProcess = null;
let activeResolve = null;
let openCodeSessionId = "";
let historyMessages = [];
let interrupted = false;
let toolSeq = 0;
const toolStarted = new Set();
let lastRunHadAuthError = false;

/**
 * Emit an event: persist to local SQLite first, then try to write to stdout.
 * If stdout is broken (main container restarted), the event is still safely stored
 * and will be retrieved via the HTTP /events endpoint when the main reconnects.
 */
function emit(obj) {
  // Persist to local outbox BEFORE stdout
  try {
    stmtInsertEvent.run(obj.type || "unknown", JSON.stringify(obj), Date.now());
  } catch (err) {
    process.stderr.write(`[event-store] Failed to persist event: ${err?.message}\n`);
  }

  // Update state snapshot for key events
  try {
    if (obj.type === "waiting_user" || obj.type === "done" || obj.type === "error") {
      setState("session_state", obj.type === "waiting_user" ? "waiting_user" : obj.type === "done" ? "done" : "error");
    } else if (obj.type === "message" || obj.type === "status" || obj.type === "tool_call" || obj.type === "model_active") {
      setState("session_state", "running");
    } else if (obj.type === "ready") {
      setState("session_state", "ready");
    }
    setState("last_activity", String(Date.now()));
  } catch { /* ignore state update failures */ }

  // Wake any long-poll waiters so they can fetch the new event immediately
  notifyEventWaiters();

  // Try stdout — tolerate EPIPE if main container is gone
  if (!stdoutBroken) {
    try {
      process.stdout.write(`${JSON.stringify(obj)}\n`);
    } catch (err) {
      if (err?.code === "EPIPE" || err?.code === "ERR_STREAM_DESTROYED") {
        stdoutBroken = true;
        process.stderr.write("[emit] stdout broken (EPIPE) — events continue in local store\n");
      }
    }
  }
}

function isSuperseded() {
  return processingGeneration < currentGeneration;
}

function emitMessage(text) {
  if (isSuperseded()) return;
  emit({ type: "message", text: String(text || "") });
}

function emitStatus(message) {
  if (isSuperseded()) return;
  emit({ type: "status", message: String(message || "") });
}

function emitWaitingUser(result) {
  if (isSuperseded()) return;
  emit({ type: "waiting_user", result: String(result || "") });
}

function emitError(message) {
  if (isSuperseded()) return;
  emit({ type: "error", message: String(message || "") });
}

function emitQuestion(requestId, questions) {
  if (isSuperseded()) return;
  emit({
    type: "question",
    requestId: String(requestId || ""),
    questions: Array.isArray(questions) ? questions : [],
  });
}

function emitProviderError(message) {
  if (isSuperseded()) return;
  emit({ type: "provider_error", message: String(message || "") });
}

function toolCallId(id) {
  if (id) return String(id);
  toolSeq += 1;
  return `opencode_tool_${toolSeq}`;
}

function emitToolStart(callId, name, input) {
  if (isSuperseded()) return;
  emit({
    type: "tool_call",
    event: "start",
    callId,
    name,
    input: input && typeof input === "object" ? input : {},
  });
}

function emitToolCompleted(callId, name, durationMs, outputPreview) {
  if (isSuperseded()) return;
  emit({
    type: "tool_call",
    event: "completed",
    callId,
    name,
    durationMs,
    outputPreview,
  });
}

function emitToolError(callId, name, durationMs, message) {
  if (isSuperseded()) return;
  emit({
    type: "tool_call",
    event: "error",
    callId,
    name,
    durationMs,
    message,
  });
}

function pickModel(modelId) {
  return MODEL_MAP[modelId] || MODEL_MAP[DEFAULT_MODEL_ID];
}

function buildOpencodeConfig() {
  return {
    $schema: "https://opencode.ai/config.json",
    permission: "allow",
    plugin: ["opencode-anthropic-oauth"],
    instructions: ["/app/AGENTS.md"],
    lsp: {
      jdtls: {
        disabled: true,
      },
    },
    mcp: {
      playwright: {
        type: "local",
        command: ["node", "/app/node_modules/@playwright/mcp/cli.js", "--browser", "chrome", "--no-sandbox"],
        enabled: true,
      },
      rick: {
        type: "local",
        command: ["node", "/app/rick-mcp.mjs"],
        enabled: true,
      },
    },
  };
}



function buildHistoryPrelude() {
  if (!Array.isArray(historyMessages) || historyMessages.length === 0) return "";

  const sliced = historyMessages.slice(-HISTORY_MAX_MESSAGES);

  // Build from newest messages first so the most recent context is always kept.
  // Each message is individually truncated to avoid a single code-diff eating
  // the entire budget. We stop adding messages once we hit the total char limit.
  const selected = [];
  let totalChars = 0;

  for (let i = sliced.length - 1; i >= 0; i--) {
    const msg = sliced[i];
    const role = msg.role === "agent" ? "assistant" : "user";
    let content = String(msg.content || "").trim();
    if (!content) continue;

    // Truncate individual messages that are very long (code diffs, full files)
    if (content.length > HISTORY_MSG_MAX_CHARS) {
      content = content.substring(0, HISTORY_MSG_MAX_CHARS) + "... (truncado)";
    }

    const line = `${role}: ${content}`;
    if (totalChars + line.length > HISTORY_MAX_CHARS && selected.length > 0) {
      break; // Budget exhausted — stop adding older messages
    }

    totalChars += line.length;
    selected.push(line);
  }

  // Reverse back to chronological order
  selected.reverse();

  const skipped = sliced.length - selected.length;
  const header = [
    "[HISTORICO_DE_CONTEXTO]",
    `As mensagens abaixo sao historico da sessao (${selected.length} de ${sliced.length} msgs${skipped > 0 ? `, ${skipped} mais antigas omitidas` : ""}). Continue a partir delas sem repetir tudo.`,
  ];

  return `${[...header, ...selected, "[/HISTORICO_DE_CONTEXTO]"].join("\n")}\n\n`;
}

async function fetchAgentJson(path) {
  const token = process.env.RICK_SESSION_TOKEN || "";
  const apiUrl = process.env.RICK_API_URL || "";
  if (!token || !apiUrl) return null;
  try {
    const response = await fetch(`${apiUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Syncs LLM credentials into OpenCode's auth.json.
 * Returns a Set of available provider keys (e.g. "anthropic", "openai", "google").
 */
async function syncOpenCodeAuth(forceRefresh = false) {
  const auth = {};
  const available = new Set();
  const forceParam = forceRefresh ? "&force=true" : "";

  const claudeBundle = await fetchAgentJson(`/api/agent/llm-auth-bundle?provider=claude${forceParam}`);
  if (claudeBundle?.auth?.type === "oauth") {
    auth.anthropic = {
      type: "oauth",
      access: String(claudeBundle.auth.accessToken || ""),
      refresh: String(claudeBundle.auth.refreshToken || ""),
      expires: Number(claudeBundle.auth.expiresAt || 0),
    };
    available.add("anthropic");
  } else if (process.env.ANTHROPIC_API_KEY) {
    auth.anthropic = {
      type: "api",
      key: process.env.ANTHROPIC_API_KEY,
    };
    available.add("anthropic");
  }

  const openAIBundle = await fetchAgentJson(`/api/agent/llm-auth-bundle?provider=openai${forceParam}`);
  if (openAIBundle?.auth?.type === "oauth") {
    const oauth = {
      type: "oauth",
      access: String(openAIBundle.auth.accessToken || ""),
      refresh: String(openAIBundle.auth.refreshToken || ""),
      expires: Number(openAIBundle.auth.expiresAt || 0),
    };
    if (openAIBundle.auth.accountId) oauth.accountId = String(openAIBundle.auth.accountId);
    auth.openai = oauth;
    available.add("openai");
  } else if (process.env.OPENAI_API_KEY) {
    auth.openai = {
      type: "api",
      key: process.env.OPENAI_API_KEY,
    };
    available.add("openai");
  }

  // Gemini uses GEMINI_API_KEY env var directly (not stored in auth.json)
  if (process.env.GEMINI_API_KEY) {
    available.add("google");
  }



  const dataDir = join(homedir(), ".local", "share", "opencode");
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, "auth.json"), JSON.stringify(auth, null, 2), { mode: 0o600 });
  return available;
}

/**
 * Maps an OpenCode model string (e.g. "anthropic/claude-opus-4-6") to its provider key.
 */
function providerForModel(opencodeModel) {
  if (opencodeModel.startsWith("anthropic/")) return "anthropic";
  if (opencodeModel.startsWith("openai/")) return "openai";
  if (opencodeModel.startsWith("google/")) return "google";
  return null;
}

/**
 * Global fallback order (strongest to weakest).
 * When the requested model fails, we walk this list top-to-bottom skipping the
 * model that already failed and any model whose provider has no credentials.
 */
const GLOBAL_FALLBACK_ORDER = [
  "claude-opus-4-6",
  "gpt-5.4",
  "gemini-3.1-pro",
];

/**
 * Given the requested model and available providers, return the best model to use.
 * Returns { modelId, opencodeModel } or null if no provider is available.
 */
function resolveModel(requestedModelId, availableProviders) {
  const opencodeModel = pickModel(requestedModelId);
  const provider = providerForModel(opencodeModel);
  if (provider && availableProviders.has(provider)) {
    return { modelId: requestedModelId, opencodeModel };
  }

  // Walk the global fallback order, skipping the requested model (already failed)
  for (const altModelId of GLOBAL_FALLBACK_ORDER) {
    if (altModelId === requestedModelId) continue;
    const altOpencodeModel = pickModel(altModelId);
    const altProvider = providerForModel(altOpencodeModel);
    if (altProvider && availableProviders.has(altProvider)) {
      return { modelId: altModelId, opencodeModel: altOpencodeModel };
    }
  }
  return null;
}

function summarizeOutput(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > 260 ? `${text.slice(0, 257)}...` : text;
}

function loadPendingQuestion(sessionId, minTimeCreated) {
  const dbPath = join(homedir(), ".local", "share", "opencode", "opencode.db");
  let db;
  try {
    db = new DatabaseSync(dbPath, { readonly: true });
    const rows = db.prepare(
      "SELECT id, time_created, data FROM part WHERE session_id = ? AND time_created >= ? ORDER BY time_created DESC LIMIT 20",
    ).all(sessionId, minTimeCreated);

    for (const row of rows) {
      let data;
      try {
        data = JSON.parse(String(row.data || "{}"));
      } catch {
        continue;
      }

      if (data?.type !== "tool" || data?.tool !== "question") continue;
      if (data?.state?.status !== "running") continue;

      const rawQuestions = data?.state?.input?.questions;
      if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) continue;

      const questions = rawQuestions
        .map((question) => {
          if (!question || typeof question !== "object") return null;
          const text = String(question.question || "").trim();
          const header = String(question.header || "").trim();
          const options = Array.isArray(question.options)
            ? question.options
              .map((option) => ({
                label: String(option?.label || "").trim(),
                description: String(option?.description || "").trim(),
              }))
              .filter((option) => option.label)
            : [];
          if (!text || !header || options.length === 0) return null;
          return {
            question: text,
            header,
            options,
            multiple: question.multiple === true,
            custom: question.custom !== false,
          };
        })
        .filter(Boolean);

      if (questions.length === 0) continue;

      return {
        requestId: String(row.id || data.id || `question_${row.time_created || Date.now()}`),
        questions,
      };
    }
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
  return null;
}

function parseToolEvent(event) {
  const part = event?.part;
  if (!part || typeof part !== "object" || part.type !== "tool") return;

  // OpenCode uses part.callID as the tool-call identifier (part.id is the internal part ID)
  const callId = toolCallId(part.callID || part.id);
  const name = String(part.tool || "tool");
  const state = part.state || {};
  const status = String(state.status || "");
  const input = state.input && typeof state.input === "object" ? state.input : {};

  // Timestamps live inside state.time (not part.time) and are epoch-ms numbers
  const time = state.time || {};
  const startedAt = typeof time.start === "number" ? time.start : 0;
  const endedAt = typeof time.end === "number" ? time.end : 0;
  const durationMs = startedAt > 0 && endedAt >= startedAt ? endedAt - startedAt : undefined;

  // OpenCode only emits tool_use events for completed/error states (not running),
  // but we still emit a start event first so the UI shows the tool invocation.
  if (!toolStarted.has(callId)) {
    toolStarted.add(callId);
    emitToolStart(callId, name, input);
  }

  if (status === "error") {
    const message = state.error ? String(state.error) : "erro na ferramenta";
    emitToolError(callId, name, durationMs, message);
    return;
  }

  if (status === "completed") {
    emitToolCompleted(callId, name, durationMs, summarizeOutput(state.output));
  }
}

function parseTextEvent(event, collector) {
  const part = event?.part;
  if (!part || part.type !== "text") return;
  const text = String(part.text || "").trim();
  if (!text) return;
  collector.push(text);
  emitMessage(text);
}

// ==================== RATE LIMIT DETECTION ====================
// OpenCode emits structured JSON errors on stdout (--format json) with:
//   { type: "error", error: { name: "APIError", data: { message, statusCode, isRetryable } } }
// OpenCode retries rate limits internally with exponential backoff before
// giving up and emitting the error. By the time we see it, retries are exhausted.
// Our job is to CASCADE to a different model, not retry the same one.

/** Detect rate-limit from a structured OpenCode JSON error event.
 *  This is the PRIMARY and most reliable detection path.
 *  @param {object} errorObj — the `event.error` object from OpenCode's JSON output */
function isStructuredRateLimitError(errorObj) {
  if (!errorObj || typeof errorObj !== "object") return false;
  const data = errorObj.data;
  if (!data) return false;

  // Direct HTTP status check — most reliable signal
  if (data.statusCode === 429 || data.statusCode === 529) return true;

  // OpenCode marks rate limits as retryable; if it gave up, we should cascade
  // (but only for APIError, not for other retryable errors like network issues)
  if (errorObj.name === "APIError" && data.isRetryable === true) {
    const msg = String(data.message || "").toLowerCase();
    // Filter: only cascade for rate-limit-like messages, not transient server errors
    if (msg.includes("rate limit") || msg.includes("rate_limit") || msg.includes("too many requests")
      || msg.includes("overloaded") || msg.includes("quota") || msg.includes("usage limit")
      || msg.includes("exhausted") || msg.includes("exceeded")) return true;
  }

  return false;
}

/** Strict rate-limit detection for stderr (OpenCode --print-logs output).
 *  Stderr contains verbose debug logs where "429" or "rate" can appear
 *  in harmless contexts (token counts, request IDs, log replay, etc.).
 *  Only match very explicit rate-limit phrases.
 *  This is a SAFETY NET for when OpenCode crashes without emitting a proper JSON error. */
function isStderrRateLimitError(message) {
  const lower = String(message || "").toLowerCase();
  // Only match unambiguous rate-limit phrases
  if (lower.includes("rate limit") || lower.includes("rate_limit") || lower.includes("too many requests")
    || lower.includes("usage limit")) return true;
  // "429" only in explicit HTTP context (status:429, code=429, HTTP/1.1 429, error 429)
  if (/(?:status|code|http|error)[\s:=]*429\b/i.test(message)) return true;
  return false;
}

let lastRunHadRateLimitError = false;
/** Timestamp until which stderr rate-limit detection should be suppressed.
 *  Set during cascade to ignore log replay from previous model's session. */
let ignoreStderrRateLimitUntil = 0;

// ==================== OPENCODE SQLITE DB ERROR HANDLING ====================
// When killTree() terminates an OpenCode process during cascade, the SQLite DB
// at ~/.local/share/opencode/opencode.db may still be locked by the dying process
// (WAL checkpoint, journal flush, etc.). The next OpenCode invocation then hits
// "SQLiteError: database is locked" and fails instantly.
//
// Additionally, if we delete the DB to recover, the in-memory openCodeSessionId
// becomes a dangling reference — OpenCode can't find that session in the new DB
// and silently produces no output.
//
// Strategy:
// 1. Detect "database is locked" and similar SQLite errors in stderr/exit output
// 2. Delete the corrupted DB and clear openCodeSessionId
// 3. Add a delay between killTree() and the next spawn to let SQLite release locks

const OPENCODE_DB_PATH = join(homedir(), ".local", "share", "opencode", "opencode.db");

/** Detect SQLite-related errors that indicate a corrupt or locked DB */
function isSqliteDbError(message) {
  const lower = String(message || "").toLowerCase();
  return lower.includes("database is locked")
    || lower.includes("database is malformed")
    || lower.includes("database disk image is malformed")
    || lower.includes("sqliteerror")
    || lower.includes("unable to open database");
}

/** Detect errors that suggest the openCodeSessionId is dangling (session not found in DB) */
function isDanglingSessionError(message) {
  const lower = String(message || "").toLowerCase();
  return lower.includes("session not found")
    || lower.includes("no such session")
    || lower.includes("session_id");
}

/** Delete the OpenCode SQLite DB and its WAL/SHM files to recover from corruption/locks */
async function nukeOpenCodeDb() {
  const files = [OPENCODE_DB_PATH, `${OPENCODE_DB_PATH}-wal`, `${OPENCODE_DB_PATH}-shm`, `${OPENCODE_DB_PATH}-journal`];
  for (const f of files) {
    try { await rm(f, { force: true }); } catch { /* ignore */ }
  }
  process.stderr.write(`[opencode-db] Deleted OpenCode DB and WAL/SHM files\n`);
}

/**
 * Extract conversation context from the local event store before nuking the DB.
 * Returns an array of { role, content } objects suitable for historyMessages.
 * This preserves context so the agent doesn't start from zero after a DB reset.
 */
function extractConversationContext() {
  try {
    const rows = stateDb.prepare(
      "SELECT data FROM events WHERE type IN ('message', 'waiting_user') ORDER BY id DESC LIMIT 30"
    ).all();

    const messages = [];
    for (const row of rows) {
      try {
        const evt = JSON.parse(row.data);
        if (evt.type === "message" && evt.text) {
          messages.push({ role: "agent", content: evt.text });
        } else if (evt.type === "waiting_user" && evt.result) {
          // waiting_user.result contains the full turn text — skip if we already have individual messages
        }
      } catch { /* ignore parse errors */ }
    }

    // Also extract the last user messages from the command handler
    // (these are stored separately — look for model_active events which follow user messages)

    // Reverse to chronological order (we queried DESC)
    messages.reverse();

    // Deduplicate consecutive messages with same content
    const deduped = [];
    for (const m of messages) {
      if (deduped.length === 0 || deduped[deduped.length - 1].content !== m.content) {
        deduped.push(m);
      }
    }

    process.stderr.write(`[opencode-db] Extracted ${deduped.length} messages from event store for context preservation\n`);
    return deduped;
  } catch (err) {
    process.stderr.write(`[opencode-db] Failed to extract context: ${err?.message}\n`);
    return [];
  }
}

/** Small delay to let OS release file locks after killing a process tree */
function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let lastRunHadDbError = false;

// Safety timeout for runOpencodeTurn: if the Promise doesn't resolve within this
// period, force-reject to prevent handleTurn from hanging forever.
// This catches edge cases where child.on("close") never fires or finish() has a
// race condition that prevents resolve/reject from being called.
// Set to 30 minutes: long enough for legitimate turns (yarn install, tsc, multiple
// tool calls) but short enough to eventually unstick a truly broken session.
// The 10-minute watchdog (WATCHDOG_MS) catches silent hangs much sooner.
const RUN_SAFETY_TIMEOUT_MS = 30 * 60_000;

function withSafetyTimeout(promise, timeoutMs, label) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      // Kill the active OpenCode process to prevent zombie processes consuming resources
      if (activeProcess) {
        process.stderr.write(`[safety-timeout] Killing active process (pid ${activeProcess.pid})\n`);
        try { process.kill(-activeProcess.pid, "SIGKILL"); } catch {}
        activeProcess = null;
      }
      reject(new Error(`${label}: safety timeout after ${timeoutMs / 60_000} minutes — Promise never resolved`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

function runOpencodeTurn({ text, model, mode, images }) {
  const innerPromise = new Promise((resolve, reject) => {
    const runStartedAt = Date.now();
    const configContent = JSON.stringify(buildOpencodeConfig());
    const selectedModel = pickModel(model);
    lastRunHadRateLimitError = false;
    lastRunHadDbError = false;

    const args = [
      "opencode-ai",
      "run",
      "--format",
      "json",
      "--model",
      selectedModel,
      "--agent",
      mode === "plan" ? "plan" : "build",
    ];

    if (openCodeSessionId) {
      args.push("--session", openCodeSessionId);
    }

    for (const imagePath of Array.isArray(images) ? images : []) {
      if (typeof imagePath === "string" && imagePath.trim()) {
        args.push("-f", imagePath.trim());
      }
    }

    // Use --print-logs so OpenCode writes detailed logs to stderr (including rate limit errors)
    args.push("--print-logs");

    // "--" stops yargs flag parsing — everything after it is treated as the message.
    // Without this, messages starting with dashes (e.g. "---" YAML front matter)
    // would be misinterpreted as unknown CLI flags, causing exit code 1.
    // NOTE: stdin pipe was attempted but doesn't work reliably because npx spawns
    // an intermediate shell (sh -c) that doesn't propagate stdin to the Bun process.
    args.push("--", text);

    // Build env: OpenCode/ai-sdk expects GOOGLE_GENERATIVE_AI_API_KEY for Gemini,
    // but our container receives GEMINI_API_KEY from the main process.
    const childEnv = {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: configContent,
    };
    if (process.env.GEMINI_API_KEY && !process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
      childEnv.GOOGLE_GENERATIVE_AI_API_KEY = process.env.GEMINI_API_KEY;
    }

    process.stderr.write(`[opencode-spawn] Spawning: npx opencode-ai run --model ${selectedModel} (textLen=${text.length}, sessionId=${openCodeSessionId || "new"})\n`);
    const child = spawn("npx", args, {
      cwd: "/workspace",
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // Create a new process group so we can kill the entire tree
    });
    process.stderr.write(`[opencode-spawn] Spawned pid=${child.pid}\n`);

    // Kill the entire process group (npx → opencode → MCP servers → Chrome).
    // With detached: true, child.pid is the process group leader.
    // Send SIGTERM first, then SIGKILL after a grace period to ensure cleanup.
    // Without SIGKILL, long-running bash commands (yarn install, tsc, etc.) may
    // ignore SIGTERM and keep the process tree alive, causing zombie processes
    // and allowing a second OpenCode to start while the first is still running.
    const killTree = () => {
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* ignore */ }
      setTimeout(() => {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* ignore — already dead */ }
      }, 5_000);
    };

    activeProcess = child;
    const collectedText = [];
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let gotMeaningfulOutput = false;
    let finished = false;
    let pendingQuestionId = "";
    const questionPollTimer = setInterval(() => {
      if (finished || !openCodeSessionId || pendingQuestionId) return;
      const pending = loadPendingQuestion(openCodeSessionId, runStartedAt);
      if (!pending) return;
      pendingQuestionId = pending.requestId;
      gotMeaningfulOutput = true;
      cancelTurnCompletionTimer();
      emitQuestion(pending.requestId, pending.questions);
      killTree();
      finish(null, "");
    }, 1000);

    // ── Inactivity watchdog ────────────────────────────────────────────
    // STARTUP WATCHDOG: if no stdout/stderr data arrives within 60s of spawn,
    // the process likely died during initialization (auth error, DB lock, etc.)
    // without producing any output. Kill and finish immediately.
    // This is separate from the main watchdog (which is for mid-run stalls).
    const STARTUP_WATCHDOG_MS = 60_000;
    let startupWatchdogTimer = setTimeout(() => {
      if (finished || gotMeaningfulOutput) return;
      process.stderr.write(`[startup-watchdog] No output for ${STARTUP_WATCHDOG_MS / 1000}s after spawn — killing\n`);
      killTree();
      finish(new Error(`OpenCode nao iniciou — nenhum output em ${STARTUP_WATCHDOG_MS / 1000}s`));
    }, STARTUP_WATCHDOG_MS);

    // If the OpenCode process emits zero stdout/stderr for WATCHDOG_MS,
    // it is likely stuck (hung API call, dead TCP connection, etc.).
    // Kill and let the caller handle the error / cascade.
    // The timer resets on ANY data (stdout or stderr), so a process that
    // is actively retrying or logging will never be killed by this.
    const WATCHDOG_MS = 10 * 60_000; // 10 minutes of total silence
    let watchdogTimer = setTimeout(() => {
      if (finished) return;
      process.stderr.write(`[watchdog] No output for ${WATCHDOG_MS / 1000}s — killing stuck process\n`);
      killTree();
      finish(new Error(`OpenCode travou — nenhum output por ${WATCHDOG_MS / 60_000} minutos`));
    }, WATCHDOG_MS);
    function resetWatchdog() {
      // Clear the startup watchdog on first output
      if (startupWatchdogTimer) { clearTimeout(startupWatchdogTimer); startupWatchdogTimer = null; }
      if (watchdogTimer) clearTimeout(watchdogTimer);
      if (finished) return;
      watchdogTimer = setTimeout(() => {
        if (finished) return;
        process.stderr.write(`[watchdog] No output for ${WATCHDOG_MS / 1000}s — killing stuck process\n`);
        killTree();
        finish(new Error(`OpenCode travou — nenhum output por ${WATCHDOG_MS / 60_000} minutos`));
      }, WATCHDOG_MS);
    }

    // Turn completion timer: after the OpenCode process finishes its last step
    // and stops emitting events, it may hang during cleanup (MCP servers,
    // Chrome, etc.) instead of exiting. This timer force-kills the process and
    // resolves with the collected text after a grace period of silence.
    //
    // IMPORTANT: Only starts after step_finish events (not after tool_use or text).
    // After a tool_use, the LLM needs time to process the result and generate
    // the next response — that can take 30+ seconds with rate-limit retries.
    // After step_finish with no subsequent step_start, the turn is truly done.
    //
    // NOTE: 30s was too aggressive — with large contexts (100+ tool calls),
    // the LLM API response can take 60+ seconds between step_finish and the
    // next step_start. This caused premature turn termination in long sessions
    // (e.g. session 99f81e0553e713a5 was killed mid-implementation).
    // The stderr reset mechanism (line ~826) mitigates this when OpenCode emits
    // logs, but API calls to Claude can be silent for 60+ seconds.
    const TURN_COMPLETION_GRACE_MS = 300_000; // 5 minutes after last step_finish
    let turnCompletionTimer = null;
    function startTurnCompletionTimer() {
      if (turnCompletionTimer) clearTimeout(turnCompletionTimer);
      if (!gotMeaningfulOutput) return; // Don't start until we have real output
      turnCompletionTimer = setTimeout(() => {
        if (finished) return;
        // Process stopped emitting events but hasn't exited — likely stuck in cleanup
        const finalText = collectedText.join("\n\n").trim();
        killTree();
        finish(null, finalText);
      }, TURN_COMPLETION_GRACE_MS);
    }
    function cancelTurnCompletionTimer() {
      if (turnCompletionTimer) clearTimeout(turnCompletionTimer);
      turnCompletionTimer = null;
    }

    child.stdout.on("data", (chunk) => {
      resetWatchdog();
      stdoutBuffer += chunk.toString();
      let newlineIndex = stdoutBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const rawLine = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        newlineIndex = stdoutBuffer.indexOf("\n");

        if (!rawLine) continue;
        let event;
        try {
          event = JSON.parse(rawLine);
        } catch {
          continue;
        }

        if (event.sessionID && typeof event.sessionID === "string") {
          openCodeSessionId = event.sessionID;
        }

        if (event.type === "tool_use") {
          gotMeaningfulOutput = true;
          cancelTurnCompletionTimer(); // LLM is active — don't time out
          parseToolEvent(event);
          continue;
        }

        if (event.type === "text") {
          gotMeaningfulOutput = true;
          cancelTurnCompletionTimer(); // LLM is active — don't time out
          parseTextEvent(event, collectedText);
          continue;
        }

        if (event.type === "step_start") {
          cancelTurnCompletionTimer(); // New step starting
          emitStatus("Pensando...");
          continue;
        }

        if (event.type === "step_finish") {
          // Step done. If no new step_start comes within the grace period,
          // the turn is complete — force-kill and resolve.
          startTurnCompletionTimer();
          continue;
        }

        if (event.type === "error") {
          // OpenCode --format json emits: { type: "error", error: { name, data: { message, statusCode, isRetryable, ... } } }
          const err = event.error;
          let message;
          let msgLower = "";
          let statusCode = "";
          let isRetryable = "";
          if (err && typeof err === "object") {
            message = (err.data && err.data.message) ? String(err.data.message) : String(err.name || JSON.stringify(err));
            msgLower = String(message).toLowerCase();
            statusCode = String(err.data?.statusCode || "");
            isRetryable = String(err.data?.isRetryable || "");
            process.stderr.write(`[provider-error] JSON error: name=${String(err.name || "")}, statusCode=${statusCode}, isRetryable=${isRetryable}, message=${String(message).substring(0, 250)}\n`);
            // Detect auth errors so handleTurn can retry with refreshed tokens.
            // Covers: "401", "auth", "Auth", "Token refresh failed", "OAuth token has been revoked"
            if (String(err.name || "").includes("Auth") ||
                msgLower.includes("401") || msgLower.includes("auth") ||
                msgLower.includes("token refresh failed") || msgLower.includes("oauth") ||
                msgLower.includes("token") && msgLower.includes("revoked")) {
              lastRunHadAuthError = true;
              process.stderr.write(`[auth-error] Detected: ${String(message).substring(0, 200)}\n`);
            }
            // Detect rate limit using the structured error object (statusCode, isRetryable, message)
            // This is the most reliable path — OpenCode already exhausted its internal retries.
            if (isStructuredRateLimitError(err)) {
              process.stderr.write(`[rate-limit] JSON error: name=${err.name}, statusCode=${statusCode}, isRetryable=${err.data?.isRetryable}, message=${String(message).substring(0, 200)}\n`);
              lastRunHadRateLimitError = true;
              killTree();
              finish(new Error(`Rate limit (${statusCode}): ${message}`));
              return;
            }
          } else {
            message = "erro do opencode";
          }
          emitProviderError(message);

          // Fatal errors (auth, model not found) — kill immediately and finish.
          // Without this, the process exits with code 0 and the Promise may hang
          // because child.on("close") has edge cases where finish() isn't called.
          if (lastRunHadAuthError || msgLower.includes("model not found") || msgLower.includes("providermodelnotfound")) {
            process.stderr.write(`[error] Fatal OpenCode error — killing immediately: ${String(message).substring(0, 200)}\n`);
            killTree();
            finish(new Error(message));
            return;
          }
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      resetWatchdog();
      // Reset turn completion timer on stderr activity: between step_finish and
      // the next step_start, the LLM API call may take 30+ seconds but OpenCode
      // logs activity to stderr (via --print-logs). Without this reset, the timer
      // would kill the process while it's legitimately waiting for the LLM response.
      if (turnCompletionTimer) startTurnCompletionTimer();
      stderrBuffer += chunk.toString();
      // Detect rate limit from OpenCode logs (enabled via --print-logs).
      // Only check the new chunk to avoid re-matching old buffer content.
      // During cascade, ignore stderr rate-limit patterns for a grace period
      // to avoid false positives from log replay of the previous model's errors.
      // Use the stricter stderr function to avoid false positives from
      // bare "429" appearing in debug output (token counts, IDs, etc.).
      if (isStderrRateLimitError(chunk.toString()) && !lastRunHadRateLimitError) {
        if (Date.now() < ignoreStderrRateLimitUntil) {
          // Grace period: this is likely log replay from the previous model, ignore it
          process.stderr.write(`[rate-limit] Stderr IGNORED (grace period): ${chunk.toString().substring(0, 200)}\n`);
          return;
        }
        process.stderr.write(`[rate-limit] Stderr detected: ${chunk.toString().substring(0, 300)}\n`);
        lastRunHadRateLimitError = true;
        killTree();
        finish(new Error("Rate limit detectado nos logs do OpenCode"));
        return;
      }
      // Detect SQLite DB errors (database is locked, malformed, etc.)
      if (isSqliteDbError(chunk.toString()) && !lastRunHadDbError) {
        process.stderr.write(`[opencode-db] SQLite error detected in stderr: ${chunk.toString().substring(0, 300)}\n`);
        lastRunHadDbError = true;
        killTree();
        finish(new Error("SQLite database error: " + chunk.toString().substring(0, 200)));
      }
    });

    const finish = (err, resultText = "") => {
      if (finished) return;
      finished = true;
      clearInterval(questionPollTimer);
      if (startupWatchdogTimer) clearTimeout(startupWatchdogTimer);
      if (watchdogTimer) clearTimeout(watchdogTimer);
      if (turnCompletionTimer) clearTimeout(turnCompletionTimer);
      if (activeResolve) {
        activeResolve = null;
      }
      activeProcess = null;
      if (err) {
        reject(err);
        return;
      }
      resolve(resultText);
    };

    activeResolve = () => {
      try {
        killTree();
      } catch {
        // ignore
      }
      finish(new Error("Interrupted"));
    };

    child.on("error", (err) => finish(err));

    child.on("close", (code, signal) => {
      const finalText = collectedText.join("\n\n").trim();
      if (interrupted || signal === "SIGTERM") {
        // If we already finished (e.g. from timeout or rate limit kill), don't double-finish
        if (finished) return;
        finish(new Error("Interrupted"));
        return;
      }

      if (code !== 0) {
        const rawDetail = stripAnsi(stderrBuffer.trim() || stdoutBuffer.trim() || `opencode run exited with code ${code}`);
        // Truncate error detail to prevent enormous messages from large stderr dumps
        // (e.g. when context window overflows from a massive user message).
        const detail = rawDetail.length > 2000 ? rawDetail.substring(0, 2000) + "... (truncado)" : rawDetail;
        // Check if the exit was due to rate limiting.
        // Use the stricter stderr function since `detail` contains the full
        // debug log buffer which may have "429" in harmless contexts.
        if (isStderrRateLimitError(detail)) {
          process.stderr.write(`[rate-limit] Process exit (code=${code}): ${detail.substring(0, 300)}\n`);
          lastRunHadRateLimitError = true;
        }
        // Check if the exit was due to SQLite DB errors
        if (isSqliteDbError(detail) || isDanglingSessionError(detail)) {
          process.stderr.write(`[opencode-db] DB error on exit (code=${code}): ${detail.substring(0, 300)}\n`);
          lastRunHadDbError = true;
        }
        finish(new Error(detail));
        return;
      }

      // Detect silent failure: process exited 0 but produced no text and no tool output.
      // This happens when openCodeSessionId references a session that doesn't exist in the DB
      // (e.g. after DB was deleted). OpenCode silently exits without doing anything.
      if (!finalText && !gotMeaningfulOutput && openCodeSessionId) {
        process.stderr.write(`[opencode-db] Silent exit with session '${openCodeSessionId}' — likely dangling session ID\n`);
        lastRunHadDbError = true;
        finish(new Error("OpenCode exited silently — possible dangling session ID"));
        return;
      }

      finish(null, finalText);
    });
  });
  // Wrap with a safety timeout to prevent the Promise from hanging forever
  // if child.on("close") never fires or finish() has a race condition.
  // No fixed safety timeout — rely on the watchdog (10min inactivity),
  // startup watchdog (60s), and turn completion timer (5min after last step_finish).
  // A fixed timeout kills legitimate long-running turns (Gradle builds, large refactors).
  return innerPromise;
}

async function handleTurn(payload) {
  await handleTurnInner(payload);
}

async function handleTurnInner(payload) {
  // Always claim the highest generation seen so far.
  // If payload carries a generation from the main container, incorporate it,
  // but always set processingGeneration = currentGeneration so that THIS turn
  // is never stale relative to interrupts that arrived while it was queued.
  if (Number.isFinite(payload.generation)) {
    currentGeneration = Math.max(currentGeneration, payload.generation);
  } else {
    currentGeneration += 1;
  }
  processingGeneration = currentGeneration;
  interrupted = false;
  toolStarted.clear();

  // Use pending model (from live switch) if set, otherwise use payload model
  const requestedModel = pendingModelId || (typeof payload.model === "string" ? payload.model : DEFAULT_MODEL_ID);
  pendingModelId = ""; // consume it
  // Use pending mode (from live switch via viewer) if set, otherwise use payload mode
  const mode = pendingMode || (payload.mode === "plan" ? "plan" : "build");
  pendingMode = ""; // consume it
  const userText = String(payload.text || "").trim();

  emit({ type: "model_active", modelId: requestedModel, modelName: requestedModel });

  try {
    process.stderr.write(`[handle-turn] Step 1: syncOpenCodeAuth starting\n`);
    const availableProviders = await Promise.race([
      syncOpenCodeAuth(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("syncOpenCodeAuth timeout (30s)")), 30_000)),
    ]);
    process.stderr.write(`[handle-turn] Step 2: syncOpenCodeAuth done, providers: ${[...availableProviders].join(",")}\n`);
    lastRunHadAuthError = false;

    // Resolve model: if requested provider's auth is missing, fall back to an available one
    const resolved = resolveModel(requestedModel, availableProviders);
    if (!resolved) {
      const providerList = [...availableProviders].join(", ") || "nenhum";
      const errorMsg = `Nenhum provedor LLM disponivel para o modelo '${requestedModel}'. Provedores com credenciais: ${providerList}. Configure OAuth ou API keys para pelo menos um provedor.`;
      emitProviderError(errorMsg);
      emitWaitingUser(errorMsg);
      return;
    }

    const { modelId: effectiveModelId, opencodeModel } = resolved;
    process.stderr.write(`[handle-turn] Step 2b: model resolved to ${effectiveModelId}, modelsToTry will be built\n`);
    if (effectiveModelId !== requestedModel) {
      emitStatus(`Modelo '${requestedModel}' indisponivel, usando '${effectiveModelId}' como fallback.`);
      emit({ type: "model_active", modelId: effectiveModelId, modelName: effectiveModelId });
    }

    let prompt = userText;
    if (!openCodeSessionId && historyMessages.length > 0) {
      prompt = `${buildHistoryPrelude()}${userText}`;
      historyMessages = [];
    }

    const runArgs = {
      text: prompt,
      model: effectiveModelId,
      mode,
      images: Array.isArray(payload.images) ? payload.images : [],
    };

    process.stderr.write(`[handle-turn] Step 2c: building modelsToTry (prompt length=${prompt.length}, sessionId=${openCodeSessionId || "new"})\n`);

    // When resuming an existing OpenCode session, --print-logs replays the entire
    // previous session's logs to stderr. This can contain text like "rate limit"
    // from LLM responses or code comments, causing false-positive rate-limit
    // detection. Set a grace period to ignore stderr rate-limit patterns during replay.
    if (openCodeSessionId) {
      ignoreStderrRateLimitUntil = Date.now() + 30_000;
    }

    // Build the ordered list of models to try: primary first, then global fallback order
    const modelsToTry = [effectiveModelId];
    for (const altModelId of GLOBAL_FALLBACK_ORDER) {
      if (modelsToTry.includes(altModelId)) continue;
      const altOpencodeModel = pickModel(altModelId);
      const altProvider = providerForModel(altOpencodeModel);
      if (altProvider && availableProviders.has(altProvider)) {
        modelsToTry.push(altModelId);
      }
    }

    let result;
    let lastError;

    for (let i = 0; i < modelsToTry.length; i++) {
      const tryModelId = modelsToTry[i];
      runArgs.model = tryModelId;
      toolStarted.clear();

      if (i > 0) {
        // Preserve openCodeSessionId so the cascade model continues the same
        // conversation context instead of starting fresh. The session retains
        // all prior tool results, file edits, and LLM context.
        //
        // --print-logs will replay the previous model's error logs on stderr,
        // including rate-limit messages. To prevent false-positive detection,
        // set a grace period during which stderr rate-limit patterns are ignored.
        ignoreStderrRateLimitUntil = Date.now() + 30_000; // 30s grace for log replay (OpenCode startup + MCP init + session replay)

        // Add a delay between cascade attempts to let SQLite release locks
        // from the killed process. Without this, the next model may hit
        // "database is locked" if the previous process is still dying.
        await sleepMs(1500);

        emitStatus(`Modelo '${modelsToTry[i - 1]}' falhou (rate limit), tentando '${tryModelId}'...`);
        emit({ type: "model_active", modelId: tryModelId, modelName: tryModelId });
      }

      process.stderr.write(`[handle-turn] Step 2d: cascade loop i=${i}, model=${tryModelId}, superseded=${isSuperseded()}, interrupted=${interrupted}, gen=${processingGeneration}/${currentGeneration}\n`);
      if (isSuperseded() || interrupted) break;

      try {
        process.stderr.write(`[handle-turn] Step 3: runOpencodeTurn starting (model=${tryModelId}, sessionId=${openCodeSessionId || "new"}, textLen=${runArgs.text.length})\n`);
        result = await runOpencodeTurn(runArgs);
        process.stderr.write(`[handle-turn] Step 4: runOpencodeTurn completed (resultLen=${String(result || "").length})\n`);

        // If the run succeeded but reported auth errors, refresh tokens and retry once
        if (lastRunHadAuthError && !isSuperseded() && !interrupted) {
          emitStatus("Renovando credenciais e tentando novamente...");
          lastRunHadAuthError = false;
          await syncOpenCodeAuth(true);
          toolStarted.clear();
          result = await runOpencodeTurn(runArgs);
        }

        lastError = null;
        break; // Success — exit the cascade
      } catch (runErr) {
        lastError = runErr;

        // SQLite DB error: progressive recovery with context preservation.
        // Level 1: Just clear session ID and retry (keeps DB, keeps context)
        // Level 2: Nuke DB but preserve conversation context via historyMessages
        // Level 3: Fall through to cascade
        if (lastRunHadDbError && !isSuperseded() && !interrupted) {
          // --- Level 1: Retry without session ID but WITH context ---
          const savedSessionId = openCodeSessionId;
          process.stderr.write(`[opencode-db] DB error detected — Level 1: clearing session ID, injecting history context, retrying\n`);
          emitStatus("Recuperando sessao do OpenCode com contexto...");
          openCodeSessionId = "";

          // Extract and inject conversation context so the new session isn't blank
          const level1Context = extractConversationContext();
          if (level1Context.length > 0) {
            historyMessages = level1Context;
            process.stderr.write(`[opencode-db] Level 1: injected ${level1Context.length} messages as history context\n`);
          }
          const level1Args = { ...runArgs };
          if (historyMessages.length > 0) {
            level1Args.text = `${buildHistoryPrelude()}${userText}`;
            historyMessages = [];
          }

          await sleepMs(1000);
          lastRunHadDbError = false;
          toolStarted.clear();
          try {
            result = await runOpencodeTurn(level1Args);
            lastError = null;
            break;
          } catch (retryErr1) {
            lastError = retryErr1;
            if (!lastRunHadDbError) {
              // Non-DB error on retry — handle normally
              if (lastRunHadRateLimitError) continue;
              break;
            }
          }

          // --- Level 2: Nuke DB but preserve conversation context ---
          process.stderr.write(`[opencode-db] Level 1 failed — Level 2: extracting context, nuking DB, retrying with history\n`);
          emitStatus("Recriando sessao do OpenCode com historico preservado...");

          // Extract conversation context BEFORE nuking
          const preservedContext = extractConversationContext();

          await nukeOpenCodeDb();
          openCodeSessionId = "";
          await sleepMs(1500);

          // Inject preserved context into historyMessages so buildHistoryPrelude() includes it
          if (preservedContext.length > 0) {
            historyMessages = preservedContext;
            process.stderr.write(`[opencode-db] Injected ${preservedContext.length} messages as history context\n`);
          }

          // Rebuild the prompt with history context included (since openCodeSessionId is now empty)
          const retryArgs = { ...runArgs };
          if (historyMessages.length > 0) {
            retryArgs.text = `${buildHistoryPrelude()}${userText}`;
            historyMessages = [];
          }

          lastRunHadDbError = false;
          toolStarted.clear();
          try {
            result = await runOpencodeTurn(retryArgs);
            lastError = null;
            break;
          } catch (retryErr2) {
            lastError = retryErr2;
            // --- Level 3: cascade to next model ---
            if (lastRunHadDbError) {
              process.stderr.write(`[opencode-db] Level 2 failed — cascading to next model\n`);
              emitStatus(`Erro persistente na sessao do OpenCode com '${tryModelId}' — tentando o proximo modelo...`);
              continue;
            }
            if (lastRunHadRateLimitError) continue;
            if (lastRunHadAuthError) {
              process.stderr.write(`[opencode-db] Retry after DB reset hit auth error — handing off to auth recovery\n`);
            }
            break;
          }
        }

        // Auth error: refresh tokens and retry the SAME model once before cascading
        if (lastRunHadAuthError && !lastRunHadRateLimitError && !isSuperseded() && !interrupted) {
          emitStatus("Renovando credenciais e tentando novamente...");
          lastRunHadAuthError = false;
          await syncOpenCodeAuth(true);
          toolStarted.clear();
          try {
            result = await runOpencodeTurn(runArgs);
            lastError = null;
            break;
          } catch (retryErr) {
            lastError = retryErr;
          }
        }

        // Rate limit / timeout: cascade to next model
        if (lastRunHadRateLimitError) {
          continue;
        }

        // Other error: don't cascade, just fail
        break;
      }
    }

    if (lastError) {
      throw lastError;
    }

    emitWaitingUser(result || "");
  } catch (err) {
    if (String(err?.message || "").includes("Interrupted")) {
      emitWaitingUser("Interrompido pelo usuario. Envie uma nova mensagem para continuar.");
      return;
    }
    const rawErrorMsg = stripAnsi(err?.message || "Falha ao processar com OpenCode");
    // Truncate to avoid sending megabytes of stderr as an error message
    const errorMsg = rawErrorMsg.length > 1000 ? rawErrorMsg.substring(0, 1000) + "... (truncado)" : rawErrorMsg;
    emitError(errorMsg);
    emitWaitingUser("");
  } finally {
    // If this turn exits without emitting waiting_user (e.g. superseded at Step 2d),
    // and no subsequent turn is queued (processingGeneration is still ours),
    // emit waiting_user to prevent the session from being stuck in "running" forever.
    const wasOurGeneration = processingGeneration === currentGeneration;
    processingGeneration = 0;
    if (wasOurGeneration && !isSuperseded()) {
      // Check if the last emitted event was NOT waiting_user/done/error.
      // This avoids duplicate waiting_user if the turn already emitted one.
      try {
        const lastState = getState("session_state");
        if (lastState === "running") {
          process.stderr.write(`[handle-turn] Safety net: turn exited without emitting waiting_user (state was 'running'), emitting now\n`);
          emitWaitingUser("");
        }
      } catch { /* ignore */ }
    }
  }
}

function handleInterrupt(generation) {
  currentGeneration = Math.max(currentGeneration, Number.isFinite(generation) ? generation : currentGeneration + 1);
  interrupted = true;
  if (activeResolve) {
    activeResolve();
  } else {
    emitWaitingUser("Interrompido.");
  }
}

function handleUpdateToken(payload) {
  if (typeof payload.token === "string" && payload.token) {
    process.env.RICK_SESSION_TOKEN = payload.token;
  }
  if (typeof payload.apiUrl === "string" && payload.apiUrl) {
    process.env.RICK_API_URL = payload.apiUrl;
  }
  emit({ type: "token_updated" });
}

/** Updated preferred model for the next turn. Does NOT interrupt a running turn.
 *  If a turn is currently running, the new model takes effect on the next message. */
let pendingModelId = "";
function handleUpdateModel(payload) {
  if (typeof payload.modelId === "string" && payload.modelId) {
    pendingModelId = payload.modelId;
    emit({ type: "model_updated", modelId: payload.modelId });
  }
}

/** Updated execution mode (plan/build) for the next turn. Does NOT interrupt a running turn. */
let pendingMode = "";
function handleUpdateMode(payload) {
  if (typeof payload.mode === "string" && (payload.mode === "plan" || payload.mode === "build")) {
    pendingMode = payload.mode;
    emit({ type: "mode_updated", mode: payload.mode });
  }
}

function handleHistory(payload) {
  const incoming = Array.isArray(payload.messages) ? payload.messages : [];
  historyMessages = incoming
    .map((item) => ({
      role: item?.role === "agent" ? "agent" : "user",
      content: String(item?.content || ""),
    }))
    .filter((item) => item.content.trim().length > 0)
    .slice(-HISTORY_MAX_MESSAGES);
  emit({ type: "history_loaded", count: historyMessages.length });
}

emit({
  type: "ready",
  providers: ["claude-opus-4-6", "gpt-5.4", "gemini-3.1-pro"],
  tools: ["opencode"],
});

// ==================== STDIN HANDLING ====================
// When agent.mjs runs as PID 1 (CMD in Dockerfile), stdin is /dev/null
// (container launched with -d / detached). Readline gets EOF immediately
// and we ignore it. All commands come via the HTTP control server.
//
// When launched via `docker exec -i` (debug/legacy), stdin is a pipe
// and readline works normally. We keep it for backward compatibility.
//
// We always create the readline — if stdin is /dev/null, it just closes
// immediately with no lines read, which is harmless.

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let stdinReceivedData = false;

rl.on("line", (line) => {
  stdinReceivedData = true;
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    emitError("Linha de entrada invalida (JSON esperado)");
    return;
  }

  if (msg.type === "interrupt") {
    handleInterrupt(msg.generation);
    return;
  }

  if (msg.type === "update_token") {
    handleUpdateToken(msg);
    return;
  }

  if (msg.type === "update_model") {
    handleUpdateModel(msg);
    return;
  }

  if (msg.type === "update_mode") {
    handleUpdateMode(msg);
    return;
  }

  if (msg.type === "history") {
    handleHistory(msg);
    return;
  }

  if (msg.type === "ping") {
    emit({ type: "pong" });
    return;
  }

  if (msg.type === "message") {
    runChain = runChain
      .then(() => handleTurn(msg))
      .catch((err) => emitError(err?.message || "Erro interno da fila de execucao"));
    return;
  }
});

rl.on("close", () => {
  stdinClosed = true;
  // Only log if we actually received data (real pipe, not /dev/null)
  if (stdinReceivedData) {
    process.stderr.write("[stdin] closed — commands will be received via HTTP control server.\n");
  }
});

// Tolerate stdout errors globally (EPIPE when main container is gone)
process.stdout.on("error", (err) => {
  if (err?.code === "EPIPE" || err?.code === "ERR_STREAM_DESTROYED") {
    stdoutBroken = true;
  }
});

// ==================== CONTROL HTTP SERVER ====================
// Lightweight HTTP server for the main container to:
// 1. Check agent health/state (GET /health)
// 2. Fetch missed events after reconnection (GET /events?after=N)
// 3. Send commands when stdin is unavailable (POST /command)

/** Route a command received via HTTP (same format as stdin NDJSON). */
function handleHttpCommand(msg) {
  if (!msg || typeof msg !== "object" || !msg.type) return;

  if (msg.type === "interrupt") {
    handleInterrupt(msg.generation);
    return;
  }
  if (msg.type === "update_token") {
    handleUpdateToken(msg);
    return;
  }
  if (msg.type === "update_model") {
    handleUpdateModel(msg);
    return;
  }
  if (msg.type === "update_mode") {
    handleUpdateMode(msg);
    return;
  }
  if (msg.type === "history") {
    handleHistory(msg);
    return;
  }
  if (msg.type === "ping") {
    emit({ type: "pong" });
    return;
  }
  if (msg.type === "message") {
    runChain = runChain
      .then(() => handleTurn(msg))
      .catch((err) => emitError(err?.message || "Erro interno da fila de execucao"));
    return;
  }
}

const httpServer = createServer((req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${CONTROL_HTTP_PORT}`);

  // CORS-free, no auth needed — only reachable within the Docker network
  res.setHeader("Content-Type", "application/json");

  // GET /health — agent state snapshot
  if (req.method === "GET" && url.pathname === "/health") {
    const state = getState("session_state") || "unknown";
    const lastActivity = Number(getState("last_activity") || "0");
    const lastEventId = getLastEventId();
    res.writeHead(200);
    res.end(JSON.stringify({
      status: "ok",
      state,
      lastEventId,
      lastActivity,
      stdinClosed,
      stdoutBroken,
      uptime: Math.floor(process.uptime()),
    }));
    return;
  }

  // GET /events?after=N[&wait=S] — fetch events with id > N
  // If wait=S is specified and there are no new events, the request blocks
  // for up to S seconds (long-poll) until new events arrive. This eliminates
  // the 500ms polling delay and gives the stream-bridge instant notification.
  if (req.method === "GET" && url.pathname === "/events") {
    const after = parseInt(url.searchParams.get("after") || "0", 10) || 0;
    const waitSec = Math.min(parseInt(url.searchParams.get("wait") || "0", 10) || 0, 60);

    const sendEvents = () => {
      try {
        const rows = stmtGetEvents.all(after);
        const events = rows.map((r) => ({ id: r.id, type: r.type, data: JSON.parse(r.data), created_at: r.created_at }));
        const state = getState("session_state") || "unknown";
        res.writeHead(200);
        res.end(JSON.stringify({ events, lastEventId: getLastEventId(), state }));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err?.message || "Failed to query events" }));
      }
    };

    // Check if there are already events to return
    try {
      const rows = stmtGetEvents.all(after);
      if (rows.length > 0 || waitSec <= 0) {
        sendEvents();
        return;
      }
    } catch {
      sendEvents();
      return;
    }

    // No events yet — wait for notification or timeout
    let resolved = false;
    const resolve = () => {
      if (resolved) return;
      resolved = true;
      eventWaiters.delete(resolve);
      sendEvents();
    };
    eventWaiters.add(resolve);

    // Timeout fallback
    const timer = setTimeout(resolve, waitSec * 1000);

    // Clean up if client disconnects
    req.on("close", () => {
      if (!resolved) {
        resolved = true;
        eventWaiters.delete(resolve);
        clearTimeout(timer);
      }
    });
    return;
  }

  // POST /command — receive a command (same as stdin NDJSON)
  if (req.method === "POST" && url.pathname === "/command") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const msg = JSON.parse(body);
        handleHttpCommand(msg);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
    return;
  }

  // 404 for anything else
  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
});

httpServer.on("error", (err) => {
  process.stderr.write(`[http] FATAL: Cannot start control server — ${err.message}\n`);
  // Explicitly mention EADDRINUSE so the main container's legacy fallback handler
  // can detect this and switch to stream bridge instead of declaring a crash.
  if (err.code === "EADDRINUSE") {
    process.stderr.write(`[http] EADDRINUSE on port ${CONTROL_HTTP_PORT} — another agent.mjs is already running\n`);
  }
  process.exit(1);
});

httpServer.listen(CONTROL_HTTP_PORT, "0.0.0.0", () => {
  process.stderr.write(`[http] Control server listening on port ${CONTROL_HTTP_PORT}\n`);
});

// The HTTP server keeps the Node.js event loop alive, which is correct:
// agent.mjs is the resident PID 1 process in the container and must stay
// running to accept commands via HTTP. In detached mode (-d), stdin is
// /dev/null and readline closes immediately — without the HTTP server
// reference the process would exit with code 0.
//
// When the agent needs to shut down, use process.exit() explicitly.
