#!/usr/bin/env node

import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const MODEL_MAP = {
  "claude-opus-4-6": "anthropic/claude-opus-4-6",
  "gpt-5.3-codex": "openai/gpt-5.3-codex",
  "gemini-3.1-pro": "google/gemini-3.1-pro-preview",
  "gemini-3.0-flash": "google/gemini-3-flash-preview",
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
    lsp: {
      jdtls: {
        disabled: true,
      },
    },
    mcp: {
      playwright: {
        type: "local",
        command: ["npx", "-y", "@playwright/mcp@latest", "--browser", "chrome"],
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

async function syncOpenCodeAuth() {
  const auth = {};

  const claudeBundle = await fetchAgentJson("/api/agent/llm-auth-bundle?provider=claude");
  if (claudeBundle?.auth?.type === "oauth") {
    auth.anthropic = {
      type: "oauth",
      access: String(claudeBundle.auth.accessToken || ""),
      refresh: String(claudeBundle.auth.refreshToken || ""),
      expires: Number(claudeBundle.auth.expiresAt || 0),
    };
  } else if (process.env.ANTHROPIC_API_KEY) {
    auth.anthropic = {
      type: "api",
      key: process.env.ANTHROPIC_API_KEY,
    };
  }

  const openAIBundle = await fetchAgentJson("/api/agent/llm-auth-bundle?provider=openai");
  if (openAIBundle?.auth?.type === "oauth") {
    const oauth = {
      type: "oauth",
      access: String(openAIBundle.auth.accessToken || ""),
      refresh: String(openAIBundle.auth.refreshToken || ""),
      expires: Number(openAIBundle.auth.expiresAt || 0),
    };
    if (openAIBundle.auth.accountId) oauth.accountId = String(openAIBundle.auth.accountId);
    auth.openai = oauth;
  } else if (process.env.OPENAI_API_KEY) {
    auth.openai = {
      type: "api",
      key: process.env.OPENAI_API_KEY,
    };
  }

  const dataDir = join(homedir(), ".local", "share", "opencode");
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, "auth.json"), JSON.stringify(auth, null, 2), { mode: 0o600 });
}

function summarizeOutput(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > 260 ? `${text.slice(0, 257)}...` : text;
}

function parseToolEvent(event) {
  const part = event?.part;
  if (!part || typeof part !== "object" || part.type !== "tool") return;

  const callId = toolCallId(part.id);
  const name = String(part.tool || "tool");
  const state = part.state || {};
  const status = String(state.status || "");
  const input = state.input && typeof state.input === "object" ? state.input : {};
  const startedAt = part.time?.start ? Number(new Date(part.time.start).getTime()) : 0;
  const endedAt = part.time?.end ? Number(new Date(part.time.end).getTime()) : 0;
  const durationMs = startedAt > 0 && endedAt >= startedAt ? endedAt - startedAt : undefined;

  if (status === "running") {
    if (!toolStarted.has(callId)) {
      toolStarted.add(callId);
      emitToolStart(callId, name, input);
    }
    return;
  }

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

function runOpencodeTurn({ text, model, mode, images }) {
  return new Promise((resolve, reject) => {
    const configContent = JSON.stringify(buildOpencodeConfig());
    const selectedModel = pickModel(model);

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

    args.push(text);

    const child = spawn("npx", args, {
      cwd: "/workspace",
      env: {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: configContent,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    activeProcess = child;
    const collectedText = [];
    let stdoutBuffer = "";
    let stderrBuffer = "";

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
          parseToolEvent(event);
          continue;
        }

        if (event.type === "text") {
          parseTextEvent(event, collectedText);
          continue;
        }

        if (event.type === "error") {
          const message = event.error ? JSON.stringify(event.error) : "erro do opencode";
          emitProviderError(message);
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderrBuffer += chunk.toString();
    });

    const finish = (err, resultText = "") => {
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
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      finish(new Error("Interrupted"));
    };

    child.on("error", (err) => finish(err));

    child.on("close", (code, signal) => {
      const finalText = collectedText.join("\n\n").trim();
      if (interrupted || signal === "SIGTERM") {
        finish(new Error("Interrupted"));
        return;
      }

      if (code !== 0) {
        const detail = stderrBuffer.trim() || stdoutBuffer.trim() || `opencode run exited with code ${code}`;
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

  const model = typeof payload.model === "string" ? payload.model : DEFAULT_MODEL_ID;
  const mode = payload.mode === "plan" ? "plan" : "build";
  const userText = String(payload.text || "").trim();

  emit({ type: "model_active", modelId: model, modelName: model });
  emitStatus(`Processando com OpenCode (${mode})...`);

  try {
    await syncOpenCodeAuth();

    let prompt = userText;
    if (!openCodeSessionId && historyMessages.length > 0) {
      prompt = `${buildHistoryPrelude()}${userText}`;
      historyMessages = [];
    }

    const result = await runOpencodeTurn({
      text: prompt,
      model,
      mode,
      images: Array.isArray(payload.images) ? payload.images : [],
    });

    emitWaitingUser(result || "Tarefa concluida.");
  } catch (err) {
    if (String(err?.message || "").includes("Interrupted")) {
      emitWaitingUser("Interrompido.");
      return;
    }
    emitError(err?.message || "Falha ao processar com OpenCode");
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
  providers: ["claude-opus-4-6", "gpt-5.3-codex", "gemini-3.1-pro", "gemini-3.0-flash"],
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
