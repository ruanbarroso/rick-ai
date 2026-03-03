#!/usr/bin/env node
/**
 * edit-agent.mjs — Multi-provider edit agent for Rick AI
 *
 * Entry point for the subagent-edit container.
 * Follows provider priority: Claude Code CLI → OpenAI → Gemini Pro
 *
 * For Claude: spawns the `claude` CLI as a subprocess and pipes through its
 *             NDJSON output unchanged — zero protocol overhead.
 *
 * For OpenAI / Gemini: runs a shared agentic loop with file-editing tools,
 *             outputting compatible NDJSON events so the host parser works
 *             identically regardless of provider.
 *
 * Usage (same interface as `claude`):
 *   node /app/edit-agent.mjs -p <prompt> [--continue] \
 *       [--system-prompt <text>] [--output-format stream-json] \
 *       [--dangerously-skip-permissions] [--verbose]
 *
 * History for non-Claude providers is persisted in /tmp/edit-history.json
 * so that --continue works across docker exec invocations.
 */

import { spawn } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { WORKSPACE, listWorkspace, executeTool } from "./tools.mjs";
import { coreToolDeclarations } from "./tool-declarations.mjs";

// ── Provider detection (priority order) ─────────────────────────────────────
// Claude Code CLI requires OAuth token or API key — ANTHROPIC_API_KEY alone
// is not enough (it's for the API, not the CLI).
const hasClaude = !!(
  process.env.CLAUDE_CODE_OAUTH_TOKEN ||
  process.env.CLAUDE_CODE_API_KEY
);
const hasOpenAI = !!(
  process.env.OPENAI_API_KEY ||
  process.env.OPENAI_ACCESS_TOKEN
);
const hasGemini = !!process.env.GEMINI_API_KEY;

// ── Argument parsing ─────────────────────────────────────────────────────────
const rawArgs = process.argv.slice(2);

let prompt = "";
let systemPrompt = "";
let isContinue = false;

for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === "-p" && rawArgs[i + 1]) {
    prompt = rawArgs[++i];
  } else if (rawArgs[i] === "--prompt-file" && rawArgs[i + 1]) {
    try { prompt = readFileSync(rawArgs[++i], "utf-8").trim(); } catch {}
  } else if (rawArgs[i] === "--system-prompt" && rawArgs[i + 1]) {
    systemPrompt = rawArgs[++i];
  } else if (rawArgs[i] === "--continue") {
    isContinue = true;
  }
}

// ── Rick API client (for querying/saving memories) ──────────────────────────

const RICK_API_URL = process.env.RICK_API_URL || "";
const RICK_SESSION_TOKEN = process.env.RICK_SESSION_TOKEN || "";

async function rickApiGet(path) {
  if (!RICK_API_URL || !RICK_SESSION_TOKEN) return null;
  try {
    const res = await fetch(`${RICK_API_URL}${path}`, {
      headers: { Authorization: `Bearer ${RICK_SESSION_TOKEN}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function rickApiPost(path, body) {
  if (!RICK_API_URL || !RICK_SESSION_TOKEN) return { error: "API não configurada" };
  try {
    const res = await fetch(`${RICK_API_URL}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RICK_SESSION_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.error || `HTTP ${res.status}` };
    return data;
  } catch (err) {
    return { error: err.message || "timeout/rede" };
  }
}

// ── Agent-specific tool handler (rick_memory, rick_search, rick_save_memory) ─

const agentName = process.env.AGENT_NAME || "Rick";

async function editToolHandler(name, input) {
  switch (name) {
    case "rick_memory": {
      const data = await rickApiGet(`/api/agent/memories${input.category ? `?category=${encodeURIComponent(input.category)}` : ""}`);
      if (!data) return "Não foi possível acessar as memórias.";
      return JSON.stringify(data.memories || [], null, 2);
    }
    case "rick_search": {
      const data = await rickApiGet(`/api/agent/search?q=${encodeURIComponent(input.query)}&limit=${input.limit || 5}`);
      if (!data) return "Busca não disponível.";
      return JSON.stringify(data.results || [], null, 2);
    }
    case "rick_save_memory": {
      const data = await rickApiPost("/api/agent/memory", {
        key: input.key,
        value: input.value,
        category: input.category || "geral",
      });
      if (data.error) return `Erro ao salvar memória: ${data.error}`;
      return `Memória salva: [${data.category}] ${data.key}`;
    }
    case "web_fetch": {
      try {
        const res = await fetch(input.url, { signal: AbortSignal.timeout(15000) });
        const text = await res.text();
        return text.length > 20000 ? text.substring(0, 20000) + "\n...(truncado)" : text;
      } catch (e) {
        return `Erro ao acessar ${input.url}: ${e.message}`;
      }
    }
    default:
      return undefined;
  }
}

// ── NDJSON helpers ───────────────────────────────────────────────────────────
function emitText(text) {
  process.stdout.write(
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }) + "\n"
  );
}

function emitToolUse(name, input) {
  process.stdout.write(
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } }) + "\n"
  );
}

function emitResult(text) {
  process.stdout.write(
    JSON.stringify({ type: "result", result: [{ type: "text", text }] }) + "\n"
  );
}

function emitError(message) {
  process.stdout.write(
    JSON.stringify({ type: "error", error: { type: "configuration_error", message } }) + "\n"
  );
}

// ── Conversation history (for non-Claude --continue support) ─────────────────
const HISTORY_FILE = "/tmp/edit-history.json";

function loadHistory() {
  if (isContinue && existsSync(HISTORY_FILE)) {
    try { return JSON.parse(readFileSync(HISTORY_FILE, "utf-8")); } catch {}
  }
  return [];
}

function saveHistory(messages) {
  try { writeFileSync(HISTORY_FILE, JSON.stringify(messages, null, 2), "utf-8"); } catch {}
}

// ── Tool declarations (core + memory tools) ─────────────────────────────────
const toolDeclarations = [
  ...coreToolDeclarations,
  {
    name: "rick_memory",
    description: `Lista memórias salvas pelo ${agentName} (credenciais, links, preferências). Sem categoria retorna TODAS.`,
    parameters: {
      type: "object",
      properties: { category: { type: "string", description: "Categoria opcional: credenciais, senhas, geral, pessoal, notas, preferencias. Omita para listar TODAS." } },
    },
  },
  {
    name: "rick_search",
    description: `Busca semântica nas conversas e memórias do ${agentName}.`,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Texto para buscar por significado" },
        limit: { type: "number", description: "Número máximo de resultados (padrão: 5)" },
      },
      required: ["query"],
    },
  },
  {
    name: "rick_save_memory",
    description: `Salva informação na memória persistente do ${agentName}. Use para URLs, preferências, padrões. NÃO use para credenciais/senhas.`,
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "Identificador curto (ex: 'github_org_zydon')" },
        value: { type: "string", description: "Valor a salvar" },
        category: { type: "string", description: "Categoria: geral, notas, preferencias, projetos, links. Padrão: geral." },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "web_fetch",
    description: "Faz uma requisição HTTP GET e retorna o conteúdo da página",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "URL para acessar" } },
      required: ["url"],
    },
  },
];

// ── Generic agentic loop (Strategy pattern) ──────────────────────────────────
/**
 * Runs a provider-agnostic agentic loop until the model stops calling tools.
 *
 * Each adapter implements:
 *   call(state)              → Promise<{ texts, toolCalls, done, nextState }>
 *   addToolResults(state, results) → nextState
 *   persistHistory(state)    → void
 *
 * toolCalls items: { name, input, id? }
 * results items:   { name, input, id?, result }
 */
async function agenticLoop(adapter) {
  let state = adapter.init();

  while (true) {
    const { texts, toolCalls, done, nextState } = await adapter.call(state);
    state = nextState;

    for (const text of texts) emitText(text);

    if (toolCalls.length > 0) {
      const results = [];
      for (const tc of toolCalls) {
        emitToolUse(tc.name, tc.input);
        const result = await executeTool(tc.name, tc.input, editToolHandler);
        results.push({ ...tc, result: String(result) });
      }
      state = adapter.addToolResults(state, results);
    }

    if (done) break;
  }

  adapter.persistHistory(state);
}

// ── OpenAI adapter ───────────────────────────────────────────────────────────
function makeOpenAIAdapter(history, userContent) {
  const apiKey = process.env.OPENAI_API_KEY ?? "";
  const oauthToken = process.env.OPENAI_ACCESS_TOKEN ?? "";
  const authHeader = oauthToken ? `Bearer ${oauthToken}` : `Bearer ${apiKey}`;
  const openaiTools = toolDeclarations.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  return {
    init() {
      return [
        ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
        ...history,
        { role: "user", content: userContent },
      ];
    },

    async call(messages) {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authHeader,
          ...(process.env.OPENAI_ACCOUNT_ID
            ? { "OpenAI-Organization": process.env.OPENAI_ACCOUNT_ID }
            : {}),
        },
        body: JSON.stringify({ model: "gpt-5.3-codex", messages, tools: openaiTools }),
        signal: AbortSignal.timeout(120_000),
      });

      if (!res.ok) {
        throw new Error(`OpenAI API error ${res.status}: ${await res.text()}`);
      }

      const data = await res.json();
      const choice = data.choices[0];
      const msg = choice.message;
      const nextState = [...messages, msg];

      const toolCalls = (msg.tool_calls ?? []).map((tc) => ({
        name: tc.function.name,
        input: (() => { try { return JSON.parse(tc.function.arguments); } catch { return {}; } })(),
        id: tc.id,
      }));

      return {
        texts: msg.content ? [msg.content] : [],
        toolCalls,
        done: toolCalls.length === 0,
        nextState,
      };
    },

    addToolResults(messages, results) {
      return [
        ...messages,
        ...results.map((r) => ({ role: "tool", tool_call_id: r.id, content: r.result })),
      ];
    },

    persistHistory(messages) {
      saveHistory(messages.filter((m) => m.role !== "system"));
    },
  };
}

// ── Gemini adapter ───────────────────────────────────────────────────────────
function makeGeminiAdapter(history, userContent) {
  const apiKey = process.env.GEMINI_API_KEY;
  const MODEL = "gemini-3.1-pro-preview";
  const BASE = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}`;
  const geminiTools = [{ functionDeclarations: toolDeclarations }];
  const systemInstruction = systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined;

  // Convert simple history format to Gemini content format
  const geminiHistory = history.map((m) => ({
    role: m.role === "user" ? "user" : "model",
    parts: [{ text: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }],
  }));

  return {
    init() {
      return [...geminiHistory, { role: "user", parts: [{ text: userContent }] }];
    },

    async call(contents) {
      const res = await fetch(`${BASE}:generateContent?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents,
          tools: geminiTools,
          ...(systemInstruction ? { systemInstruction } : {}),
        }),
        signal: AbortSignal.timeout(120_000),
      });

      if (!res.ok) {
        throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);
      }

      const data = await res.json();
      const candidate = data.candidates?.[0];
      if (!candidate) {
        throw new Error("Gemini retornou resposta vazia.");
      }

      const modelParts = candidate.content.parts ?? [];
      const nextState = [...contents, { role: "model", parts: modelParts }];

      const texts = modelParts.filter((p) => p.text).map((p) => p.text);
      const toolCalls = modelParts
        .filter((p) => p.functionCall)
        .map((p) => ({ name: p.functionCall.name, input: p.functionCall.args ?? {} }));

      return { texts, toolCalls, done: toolCalls.length === 0, nextState };
    },

    addToolResults(contents, results) {
      return [
        ...contents,
        {
          role: "user",
          parts: results.map((r) => ({
            functionResponse: { name: r.name, response: { result: r.result } },
          })),
        },
      ];
    },

    persistHistory(contents) {
      saveHistory(
        contents
          .map((c) => ({
            role: c.role === "model" ? "assistant" : "user",
            content: c.parts
              .map((p) => {
                if (p.text) return p.text;
                if (p.functionCall) return `[Tool: ${p.functionCall.name}(${JSON.stringify(p.functionCall.args ?? {})})]`;
                if (p.functionResponse) return `[Result: ${p.functionResponse.name} → ${JSON.stringify(p.functionResponse.response?.result ?? "").slice(0, 500)}]`;
                return "";
              })
              .filter(Boolean)
              .join("\n"),
          }))
          .filter((m) => m.content)
      );
    },
  };
}

// ── Claude raw passthrough ──────────────────────────────────────────────────

async function runClaudeRaw() {
  return await new Promise((resolve) => {
    const child = spawn("claude", rawArgs, { stdio: ["inherit", "pipe", "pipe"] });
    let hadStdout = false;

    child.stdout?.on("data", (chunk) => {
      if (chunk.length > 0) hadStdout = true;
      process.stdout.write(chunk);
    });

    child.stderr?.on("data", (chunk) => {
      process.stderr.write(chunk);
    });

    child.on("exit", (code) => resolve({ ok: (code ?? 0) === 0, code: code ?? 0, hadStdout }));
    child.on("error", (err) => {
      process.stderr.write(`Erro ao iniciar Claude CLI: ${err.message}\n`);
      resolve({ ok: false, code: 1, hadStdout: false });
    });
  });
}

// ── Main with provider fallback ───────────────────────────────────────────────
if (!prompt) {
  emitError("Nenhum prompt fornecido (flag -p ausente).");
  process.exit(1);
}

const history = loadHistory();
const fileList = listWorkspace(WORKSPACE).join("\n") || "(workspace vazio)";
const userContent = `Arquivos disponíveis no workspace:\n${fileList}\n\n---\n\n${prompt}`;
const errors = [];

// Provider cascade: Claude CLI → OpenAI → Gemini
const providers = [
  hasClaude && {
    name: "Claude",
    async run() {
      const claude = await runClaudeRaw();
      if (claude.ok) process.exit(0);
      // If Claude produced output and then failed, preserve that failure and stop.
      if (claude.hadStdout) process.exit(claude.code || 1);
      throw new Error(`Claude CLI saiu com code ${claude.code || 1}`);
    },
  },
  hasOpenAI && {
    name: "OpenAI",
    async run() {
      await agenticLoop(makeOpenAIAdapter(history, userContent));
      process.exit(0);
    },
  },
  hasGemini && {
    name: "Gemini",
    async run() {
      await agenticLoop(makeGeminiAdapter(history, userContent));
      process.exit(0);
    },
  },
].filter(Boolean);

if (providers.length === 0) {
  emitError(
    "Nenhum provedor de LLM disponível no container. " +
    "Configure CLAUDE_CODE_OAUTH_TOKEN, OPENAI_API_KEY ou GEMINI_API_KEY."
  );
  process.exit(1);
}

for (const provider of providers) {
  try {
    await provider.run();
  } catch (err) {
    errors.push(err?.message || String(err));
  }
}

emitError(`Todos os provedores falharam: ${errors.join(" | ")}`);
process.exit(1);
