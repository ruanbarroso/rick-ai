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
import { WORKSPACE, listWorkspace, executeTool, redactSecrets } from "./tools.mjs";
import { coreToolDeclarations } from "./tool-declarations.mjs";
import {
  agentToolHandler as sharedAgentToolHandler,
  buildAgentToolDeclarations,
  LLM_TIMEOUT_MS,
} from "./rick-api.mjs";

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

// ── Rick API + agent tools (imported from rick-api.mjs) ─────────────────────

const agentName = process.env.AGENT_NAME || "Rick";

// ── NDJSON helpers ───────────────────────────────────────────────────────────
function emitText(text) {
  process.stdout.write(
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: redactSecrets(text) }] } }) + "\n"
  );
}

function emitToolUse(name, input) {
  process.stdout.write(
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } }) + "\n"
  );
}

function emitResult(text) {
  process.stdout.write(
    JSON.stringify({ type: "result", result: [{ type: "text", text: redactSecrets(text) }] }) + "\n"
  );
}

function emitError(message) {
  process.stdout.write(
    JSON.stringify({ type: "error", error: { type: "configuration_error", message: redactSecrets(message) } }) + "\n"
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

// ── Tool declarations (core + agent-specific from rick-api.mjs) ──────────────
const toolDeclarations = [...coreToolDeclarations, ...buildAgentToolDeclarations(agentName)];

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
        const result = await executeTool(tc.name, tc.input, sharedAgentToolHandler);
        results.push({ ...tc, result: String(result) });
      }
      state = adapter.addToolResults(state, results);
    }

    if (done) break;
  }

  adapter.persistHistory(state);
}

// ── OpenAI adapter ───────────────────────────────────────────────────────────
// Codex Responses API endpoint for OAuth mode (same as opencode)
const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

function makeOpenAIAdapter(history, userContent) {
  const apiKey = process.env.OPENAI_API_KEY ?? "";
  const oauthToken = process.env.OPENAI_ACCESS_TOKEN ?? "";
  const useCodexApi = !!oauthToken && !apiKey;

  if (useCodexApi) {
    return makeOpenAICodexAdapter(history, userContent, oauthToken);
  }

  // Standard API key mode — Chat Completions API
  const authHeader = `Bearer ${apiKey || oauthToken}`;
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
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
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

/**
 * OAuth mode — Codex Responses API adapter.
 * Uses chatgpt.com/backend-api/codex/responses instead of api.openai.com.
 */
function makeOpenAICodexAdapter(history, userContent, oauthToken) {
  const accountId = process.env.OPENAI_ACCOUNT_ID || "";

  const responsesTools = toolDeclarations.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));

  return {
    init() {
      // Build Responses API input from history
      const input = [];
      for (const m of history) {
        if (m.role === "user") {
          input.push({ role: "user", content: [{ type: "input_text", text: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }] });
        } else if (m.role === "assistant") {
          input.push({ role: "assistant", content: [{ type: "output_text", text: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }] });
        }
      }
      input.push({ role: "user", content: [{ type: "input_text", text: userContent }] });
      return input;
    },

    async call(input) {
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${oauthToken}`,
        "User-Agent": "rick-ai/1.0",
        originator: "opencode",
      };
      if (accountId) {
        headers["ChatGPT-Account-Id"] = accountId;
      }

      const res = await fetch(CODEX_API_ENDPOINT, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "gpt-5.3-codex",
          instructions: systemPrompt || "",
          input,
          tools: responsesTools,
          store: false,
          stream: false,
        }),
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      });

      if (!res.ok) {
        throw new Error(`OpenAI Codex API error ${res.status}: ${await res.text()}`);
      }

      const data = await res.json();
      let text = "";
      const toolCalls = [];

      if (data.output && Array.isArray(data.output)) {
        for (const item of data.output) {
          if (item.type === "message" && item.content) {
            for (const part of item.content) {
              if (part.type === "output_text") text += part.text;
            }
          }
          if (item.type === "function_call") {
            toolCalls.push({
              name: item.name,
              input: (() => { try { return JSON.parse(item.arguments); } catch { return {}; } })(),
              id: item.call_id,
            });
          }
        }
      }

      return {
        texts: text ? [text] : [],
        toolCalls,
        done: toolCalls.length === 0,
        nextState: input,
      };
    },

    addToolResults(input, results) {
      const extended = [...input];
      for (const r of results) {
        extended.push({
          type: "function_call",
          name: r.name,
          arguments: JSON.stringify(r.input ?? {}),
          call_id: r.id,
        });
        extended.push({
          type: "function_call_output",
          call_id: r.id,
          output: r.result,
        });
      }
      return extended;
    },

    persistHistory(input) {
      // Convert Responses API input back to simple format for persistence
      const simple = [];
      for (const item of input) {
        if (item.role === "user" && item.content?.[0]?.text) {
          simple.push({ role: "user", content: item.content[0].text });
        } else if (item.role === "assistant" && item.content?.[0]?.text) {
          simple.push({ role: "assistant", content: item.content[0].text });
        }
      }
      saveHistory(simple);
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
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
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

/**
 * Detect rate-limit / quota-exhaustion signals in Claude CLI output.
 * These indicate the provider refused to process the request — NOT that useful
 * output was produced. In this case, we should fall through to the next provider.
 */
function isRateLimitOrQuotaError(text) {
  const lower = text.toLowerCase();
  return (
    lower.includes("rate limit") ||
    lower.includes("429") ||
    lower.includes("overloaded") ||
    lower.includes("credits") ||
    lower.includes("quota") ||
    lower.includes("hit your limit") ||
    lower.includes("out of extra usage") ||
    lower.includes("out of usage") ||
    (lower.includes("limit") && lower.includes("resets"))
  );
}

async function runClaudeRaw() {
  return await new Promise((resolve) => {
    const child = spawn("claude", rawArgs, { stdio: ["inherit", "pipe", "pipe"] });
    let hadStdout = false;
    let allStdout = "";

    child.stdout?.on("data", (chunk) => {
      if (chunk.length > 0) hadStdout = true;
      allStdout += chunk.toString();
      process.stdout.write(chunk);
    });

    child.stderr?.on("data", (chunk) => {
      allStdout += chunk.toString(); // also collect stderr for rate-limit detection
      process.stderr.write(chunk);
    });

    child.on("exit", (code) => {
      const rateLimited = isRateLimitOrQuotaError(allStdout);
      resolve({ ok: (code ?? 0) === 0, code: code ?? 0, hadStdout, rateLimited });
    });
    child.on("error", (err) => {
      process.stderr.write(`Erro ao iniciar Claude CLI: ${err.message}\n`);
      resolve({ ok: false, code: 1, hadStdout: false, rateLimited: false });
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
      // Rate limit / quota exhaustion — fall through to next provider even if
      // Claude wrote output (the output was just the error message, not useful work).
      if (claude.rateLimited) {
        throw new Error(`Claude rate limited (code ${claude.code || 1})`);
      }
      // If Claude produced real output and then failed mid-stream, preserve that
      // failure and stop — retrying with another provider would duplicate content.
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
