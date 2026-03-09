#!/usr/bin/env node

import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const MODEL_MAP = {
  "claude-opus-4-6": "anthropic/claude-opus-4-6",
  "gpt-5.3-codex": "openai/gpt-5.3-codex",
  "minimax-m2.5-free": "opencode/minimax-m2.5-free",
};

const DEFAULT_MODEL_ID = "claude-opus-4-6";
const HISTORY_MAX_MESSAGES = 120;

/** Models with short-lived rate limits that clear after a few seconds.
 *  For these, we count consecutive rate-limit errors and only kill
 *  after RATE_LIMIT_MAX_RETRIES hits. If a normal event arrives in
 *  between (text, tool_use, step_start), the counter resets — OpenCode
 *  recovered on its own via its internal exponential backoff. */
const RATE_LIMIT_TOLERANT_MODELS = new Set(["minimax-m2.5-free"]);
const RATE_LIMIT_MAX_RETRIES = 3;

/** Idle timeout: kill the process if it produces no new output for this long.
 *  Resets on every meaningful event (text, tool_use, step_start).
 *  Catches providers that hang mid-turn (e.g. Zen API stops responding
 *  after tool results are sent back for the next generation round). */
const LLM_IDLE_TIMEOUT_MS = 120_000; // 2 minutes of silence → kill

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

  // OpenCode Zen: MiniMax M2.5 Free is available through the Zen gateway.
  // The Zen server recognises the literal key "public" as anonymous access
  // for models flagged allowAnonymous (free-tier models like minimax-m2.5-free).
  // If the user has a real Zen API key in OPENCODE_ZEN_API_KEY, use that instead.
  const zenKey = process.env.OPENCODE_ZEN_API_KEY || "public";
  auth.opencode = {
    type: "api",
    key: zenKey,
  };
  available.add("opencode");

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
  if (opencodeModel.startsWith("opencode/")) return "opencode";
  return null;
}

/**
 * Global fallback order (strongest to weakest).
 * When the requested model fails, we walk this list top-to-bottom skipping the
 * model that already failed and any model whose provider has no credentials.
 */
const GLOBAL_FALLBACK_ORDER = [
  "claude-opus-4-6",
  "gpt-5.3-codex",
  "minimax-m2.5-free",
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

/** Detect rate-limit / usage-limit patterns in error messages. */
function isRateLimitError(message) {
  const lower = String(message || "").toLowerCase();
  return lower.includes("usage limit") || lower.includes("rate limit") || lower.includes("429") || lower.includes("quota") || lower.includes("too many requests");
}

let lastRunHadRateLimitError = false;

function runOpencodeTurn({ text, model, mode, images }) {
  return new Promise((resolve, reject) => {
    const configContent = JSON.stringify(buildOpencodeConfig());
    const selectedModel = pickModel(model);
    const isTolerant = RATE_LIMIT_TOLERANT_MODELS.has(model);
    const maxRateLimits = isTolerant ? RATE_LIMIT_MAX_RETRIES : 1;
    let rateLimitCount = 0;
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

    args.push(text);

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
    // Debounce timestamp: prevents double-counting the same rate-limit event
    // from both stderr (--print-logs) and stdout (JSON error event).
    let lastRateLimitBumpTime = 0;

    // Rolling idle timer: resets every time the process emits meaningful output.
    // If the process goes silent for LLM_IDLE_TIMEOUT_MS (e.g. Zen API hangs
    // mid-turn after tool results), kill it so the cascade can try another model.
    let idleTimer = setTimeout(onIdle, LLM_IDLE_TIMEOUT_MS);
    function resetIdleTimer() {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(onIdle, LLM_IDLE_TIMEOUT_MS);
    }
    function onIdle() {
      if (finished) return;
      lastRunHadRateLimitError = true; // treat prolonged silence as provider issue → cascade
      killTree();
      finish(new Error("LLM idle timeout: nenhuma resposta em " + (LLM_IDLE_TIMEOUT_MS / 1000) + "s — provedor parou de responder"));
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
          rateLimitCount = 0; // recovered — reset consecutive rate limit counter
          resetIdleTimer();
          parseToolEvent(event);
          continue;
        }

        if (event.type === "text") {
          gotMeaningfulOutput = true;
          rateLimitCount = 0; // recovered — reset consecutive rate limit counter
          resetIdleTimer();
          parseTextEvent(event, collectedText);
          continue;
        }

        if (event.type === "step_start") {
          rateLimitCount = 0; // recovered — reset consecutive rate limit counter
          resetIdleTimer();
          emitStatus("Pensando...");
          continue;
        }

        if (event.type === "step_finish") {
          resetIdleTimer();
          continue;
        }

        if (event.type === "error") {
          resetIdleTimer();
          // session.error has { error: { name, data? } }
          const err = event.error;
          let message;
          if (err && typeof err === "object") {
            message = (err.data && err.data.message) ? String(err.data.message) : String(err.name || JSON.stringify(err));
            // Detect auth errors so handleTurn can retry with refreshed tokens
            if (String(err.name || "").includes("Auth") || String(message).includes("401") || String(message).includes("auth")) {
              lastRunHadAuthError = true;
            }
            // Detect rate limit / usage limit errors for provider cascade
            if (isRateLimitError(message)) {
              const now = Date.now();
              // Debounce: skip if stderr already counted this within 2 seconds
              if (now - lastRateLimitBumpTime >= 2000) {
                lastRateLimitBumpTime = now;
                rateLimitCount++;
              }
              if (rateLimitCount >= maxRateLimits) {
                lastRunHadRateLimitError = true;
                killTree();
                finish(new Error(`Rate limit: ${message}`));
                return;
              }
              // Tolerant model — let OpenCode's internal retries handle it
              emitStatus(`Rate limit temporário (${rateLimitCount}/${maxRateLimits}), OpenCode retentando...`);
              return; // don't emit as provider error, just wait
            }
          } else {
            message = "erro do opencode";
          }
          emitProviderError(message);
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrBuffer += text;
      // Detect rate limit from OpenCode logs (enabled via --print-logs).
      // Only check the new chunk to avoid re-matching old buffer content.
      if (isRateLimitError(text) && !lastRunHadRateLimitError) {
        const now = Date.now();
        // Debounce: skip if we already bumped the counter within 2 seconds
        // (avoids double-counting the same error from stderr + stdout)
        if (now - lastRateLimitBumpTime < 2000) return;
        lastRateLimitBumpTime = now;
        rateLimitCount++;
        if (rateLimitCount >= maxRateLimits) {
          lastRunHadRateLimitError = true;
          killTree();
          finish(new Error("Rate limit detectado nos logs do OpenCode"));
        } else if (isTolerant) {
          emitStatus(`Rate limit temporário (${rateLimitCount}/${maxRateLimits}), OpenCode retentando...`);
        } else {
          // Non-tolerant model: kill on first hit
          lastRunHadRateLimitError = true;
          killTree();
          finish(new Error("Rate limit detectado nos logs do OpenCode"));
        }
      }
    });

    const finish = (err, resultText = "") => {
      if (finished) return;
      finished = true;
      clearTimeout(idleTimer);
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
        const detail = stderrBuffer.trim() || stdoutBuffer.trim() || `opencode run exited with code ${code}`;
        // Check if the exit was due to rate limiting
        if (isRateLimitError(detail)) {
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

  const requestedModel = typeof payload.model === "string" ? payload.model : DEFAULT_MODEL_ID;
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
        // Reset session so the new model starts fresh.
        // Without this, --print-logs replays the previous model's error logs
        // (including rate-limit messages), causing a false-positive detection
        // that kills the new model before it even starts.
        openCodeSessionId = "";
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
    const errorMsg = err?.message || "Falha ao processar com OpenCode";
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
  providers: ["claude-opus-4-6", "gpt-5.3-codex", "minimax-m2.5-free"],
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
