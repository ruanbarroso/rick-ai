#!/usr/bin/env node

import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const MODEL_MAP = {
  "claude-opus-4-6": "anthropic/claude-opus-4-6",
  "gpt-5.4": "openai/gpt-5.4",
  "gemini-3.1-pro": "google/gemini-3.1-pro-preview",
};

const DEFAULT_MODEL_ID = "claude-opus-4-6";
const HISTORY_MAX_MESSAGES = 120;





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

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
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
  const lines = [
    "[HISTORICO_DE_CONTEXTO]",
    "As mensagens abaixo sao historico da sessao. Continue a partir delas sem repetir tudo.",
  ];
  const sliced = historyMessages.slice(-HISTORY_MAX_MESSAGES);
  for (const message of sliced) {
    const role = message.role === "agent" ? "assistant" : "user";
    const content = String(message.content || "").trim();
    if (!content) continue;
    lines.push(`${role}: ${content}`);
  }
  lines.push("[/HISTORICO_DE_CONTEXTO]");
  return `${lines.join("\n")}\n\n`;
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

function runOpencodeTurn({ text, model, mode, images }) {
  return new Promise((resolve, reject) => {
    const configContent = JSON.stringify(buildOpencodeConfig());
    const selectedModel = pickModel(model);
    lastRunHadRateLimitError = false;

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

    const child = spawn("npx", args, {
      cwd: "/workspace",
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // Create a new process group so we can kill the entire tree
    });

    // Kill the entire process group (npx → opencode → MCP servers → Chrome).
    // With detached: true, child.pid is the process group leader.
    const killTree = () => {
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* ignore */ }
    };

    activeProcess = child;
    const collectedText = [];
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let gotMeaningfulOutput = false;
    let finished = false;

    // Turn completion timer: after the OpenCode process finishes its last step
    // and stops emitting events, it may hang during cleanup (MCP servers,
    // Chrome, etc.) instead of exiting. This timer force-kills the process and
    // resolves with the collected text after a grace period of silence.
    //
    // IMPORTANT: Only starts after step_finish events (not after tool_use or text).
    // After a tool_use, the LLM needs time to process the result and generate
    // the next response — that can take 30+ seconds with rate-limit retries.
    // After step_finish with no subsequent step_start, the turn is truly done.
    const TURN_COMPLETION_GRACE_MS = 15_000; // 15s after last step_finish
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
          if (err && typeof err === "object") {
            message = (err.data && err.data.message) ? String(err.data.message) : String(err.name || JSON.stringify(err));
            // Detect auth errors so handleTurn can retry with refreshed tokens
            if (String(err.name || "").includes("Auth") || String(message).includes("401") || String(message).includes("auth")) {
              lastRunHadAuthError = true;
            }
            // Detect rate limit using the structured error object (statusCode, isRetryable, message)
            // This is the most reliable path — OpenCode already exhausted its internal retries.
            if (isStructuredRateLimitError(err)) {
              const statusCode = err.data?.statusCode || "";
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
        }
      }
    });

    child.stderr.on("data", (chunk) => {
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
      }
    });

    const finish = (err, resultText = "") => {
      if (finished) return;
      finished = true;
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
        const rawDetail = stderrBuffer.trim() || stdoutBuffer.trim() || `opencode run exited with code ${code}`;
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
        finish(new Error(detail));
        return;
      }

      finish(null, finalText);
    });
  });
}

async function handleTurn(payload) {
  const generation = Number.isFinite(payload.generation) ? payload.generation : currentGeneration + 1;
  currentGeneration = Math.max(currentGeneration, generation);
  processingGeneration = generation;
  interrupted = false;
  toolStarted.clear();

  // Use pending model (from live switch) if set, otherwise use payload model
  const requestedModel = pendingModelId || (typeof payload.model === "string" ? payload.model : DEFAULT_MODEL_ID);
  pendingModelId = ""; // consume it
  const mode = payload.mode === "plan" ? "plan" : "build";
  const userText = String(payload.text || "").trim();

  emit({ type: "model_active", modelId: requestedModel, modelName: requestedModel });

  try {
    const availableProviders = await syncOpenCodeAuth();
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
        emitStatus(`Modelo '${modelsToTry[i - 1]}' falhou (rate limit), tentando '${tryModelId}'...`);
        emit({ type: "model_active", modelId: tryModelId, modelName: tryModelId });
      }

      if (isSuperseded() || interrupted) break;

      try {
        result = await runOpencodeTurn(runArgs);

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
      emitWaitingUser("Interrompido.");
      return;
    }
    const rawErrorMsg = err?.message || "Falha ao processar com OpenCode";
    // Truncate to avoid sending megabytes of stderr as an error message
    const errorMsg = rawErrorMsg.length > 1000 ? rawErrorMsg.substring(0, 1000) + "... (truncado)" : rawErrorMsg;
    emitError(errorMsg);
    emitWaitingUser("");
  } finally {
    processingGeneration = 0;
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

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
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
