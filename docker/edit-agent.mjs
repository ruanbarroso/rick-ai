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
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  existsSync,
  mkdirSync,
} from "fs";
import { join, relative } from "path";

// ── Provider detection (priority order) ─────────────────────────────────────
const hasClaude = !!(
  process.env.CLAUDE_CODE_OAUTH_TOKEN ||
  process.env.CLAUDE_CODE_API_KEY ||
  process.env.ANTHROPIC_API_KEY
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

// ── Workspace file tools ─────────────────────────────────────────────────────
const WORKSPACE = "/workspace";

function resolvePath(p) {
  if (!p) return WORKSPACE;
  return p.startsWith("/") ? p : join(WORKSPACE, p);
}

function listWorkspace(dir, depth = 0) {
  if (depth > 3) return [];
  try {
    return readdirSync(dir).flatMap((entry) => {
      if (entry === "node_modules" || entry.startsWith(".")) return [];
      const fp = join(dir, entry);
      try {
        const st = statSync(fp);
        const rel = relative(WORKSPACE, fp);
        if (st.isDirectory()) return [rel + "/", ...listWorkspace(fp, depth + 1)];
        return [rel];
      } catch { return []; }
    });
  } catch { return []; }
}

async function executeTool(name, input) {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);

  switch (name) {
    case "read_file": {
      const fp = resolvePath(input.path);
      try { return readFileSync(fp, "utf-8"); }
      catch (e) { return `Erro ao ler arquivo: ${e.message}`; }
    }
    case "write_file": {
      const fp = resolvePath(input.path);
      try {
        const dir = fp.substring(0, fp.lastIndexOf("/"));
        if (dir) mkdirSync(dir, { recursive: true });
        writeFileSync(fp, input.content ?? "", "utf-8");
        return `Arquivo escrito: ${fp}`;
      } catch (e) { return `Erro ao escrever arquivo: ${e.message}`; }
    }
    case "edit_file": {
      const fp = resolvePath(input.path);
      try {
        let content = readFileSync(fp, "utf-8");
        if (!content.includes(input.old_string)) {
          return `Erro: old_string não encontrado em ${fp}`;
        }
        content = content.replace(input.old_string, input.new_string);
        writeFileSync(fp, content, "utf-8");
        return `Arquivo editado: ${fp}`;
      } catch (e) { return `Erro ao editar arquivo: ${e.message}`; }
    }
    case "list_directory": {
      const dp = resolvePath(input.path);
      const entries = listWorkspace(dp);
      return entries.length ? entries.join("\n") : "(diretório vazio)";
    }
    case "run_command": {
      try {
        const { stdout, stderr } = await execFileAsync(
          input.command,
          input.args ?? [],
          { cwd: WORKSPACE, timeout: 60_000 }
        );
        return (stdout || "") + (stderr ? `\nSTDERR: ${stderr}` : "");
      } catch (e) {
        return `Saída ${e.code ?? 1}:\n${e.stdout ?? ""}\n${e.stderr ?? ""}`.trim();
      }
    }
    default:
      return `Ferramenta desconhecida: ${name}`;
  }
}

// Tool declarations (shared between OpenAI and Gemini adapters)
const toolDeclarations = [
  {
    name: "read_file",
    description: "Lê o conteúdo de um arquivo do workspace",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Caminho relativo a /workspace ou absoluto" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Escreve conteúdo em um arquivo (cria se não existir)",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Substitui uma string exata em um arquivo (primeira ocorrência)",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string", description: "String exata a ser substituída" },
        new_string: { type: "string", description: "String de substituição" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "list_directory",
    description: "Lista arquivos do workspace recursivamente",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Diretório a listar (padrão: /workspace)" },
      },
    },
  },
  {
    name: "run_command",
    description: "Executa um comando no /workspace (ex: npx tsc --noEmit)",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        args: { type: "array", items: { type: "string" } },
      },
      required: ["command"],
    },
  },
];

// ── Generic agentic loop (Strategy pattern) ──────────────────────────────────
/**
 * Runs a provider-agnostic agentic loop until the model stops calling tools
 * or MAX_ITER is reached.
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
  const MAX_ITER = 20;
  let state = adapter.init();

  for (let iter = 0; iter < MAX_ITER; iter++) {
    const { texts, toolCalls, done, nextState } = await adapter.call(state);
    state = nextState;

    for (const text of texts) emitText(text);

    if (toolCalls.length > 0) {
      const results = [];
      for (const tc of toolCalls) {
        emitToolUse(tc.name, tc.input);
        const result = await executeTool(tc.name, tc.input);
        results.push({ ...tc, result: String(result) });
      }
      state = adapter.addToolResults(state, results);
    }

    if (done) break;
  }

  adapter.persistHistory(state);
}

async function runOpenAI(history, userContent) {
  await agenticLoop(makeOpenAIAdapter(history, userContent));
  emitResult("Tarefa concluida pelo GPT.");
}

async function runGemini(history, userContent) {
  await agenticLoop(makeGeminiAdapter(history, userContent));
  emitResult("Tarefa concluida pelo Gemini Pro.");
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
        done: choice.finish_reason === "stop" && toolCalls.length === 0,
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
            content: c.parts.map((p) => p.text ?? "").join(""),
          }))
          .filter((m) => m.content)
      );
    },
  };
}

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

if (hasClaude) {
  const claude = await runClaudeRaw();
  if (claude.ok) {
    process.exit(0);
  }
  // If Claude produced output and then failed, preserve that failure and stop.
  if (claude.hadStdout) {
    process.exit(claude.code || 1);
  }
  errors.push(`Claude CLI saiu com code ${claude.code || 1}`);
}

if (hasOpenAI) {
  try {
    await runOpenAI(history, userContent);
    process.exit(0);
  } catch (err) {
    errors.push(err?.message || String(err));
  }
}

if (hasGemini) {
  try {
    await runGemini(history, userContent);
    process.exit(0);
  } catch (err) {
    errors.push(err?.message || String(err));
  }
}

if (!hasClaude && !hasOpenAI && !hasGemini) {
  emitError(
    "Nenhum provedor de LLM disponivel no container. " +
    "Configure CLAUDE_CODE_OAUTH_TOKEN, OPENAI_API_KEY ou GEMINI_API_KEY."
  );
  process.exit(1);
}

emitError(`Todos os provedores falharam: ${errors.join(" | ")}`);
process.exit(1);
