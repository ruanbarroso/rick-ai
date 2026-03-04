#!/usr/bin/env node
/**
 * agent.mjs — Unified sub-agent for AI assistant
 *
 * Entry point for the "subagent" container. Runs an agentic loop that:
 *  - Reads tasks from stdin as NDJSON  { type: "message", text, images? }
 *  - Executes tools (files, commands, web fetch, web browse)
 *  - Emits progress/results to stdout as NDJSON
 *
 * Provider priority: Claude API → OpenAI → Gemini Pro
 *
 * Protocol (stdout NDJSON):
 *   { type: "ready", providers: [...], tools: [...] }
 *   { type: "message", text: "..." }
 *   { type: "status", message: "..." }
 *   { type: "waiting_user", result: "..." }  — turn complete, waiting for next user message
 *   { type: "done", result: "..." }           — session finished (explicit end)
 *   { type: "error", message: "..." }
 */

import { createInterface } from "readline";
import { WORKSPACE, listWorkspace, executeTool, toolStatusLabel } from "./tools.mjs";
import { coreToolDeclarations } from "./tool-declarations.mjs";
import {
  rickApiGet, rickApiPost, agentToolHandler as sharedAgentToolHandler,
  buildAgentToolDeclarations,
  LLM_TIMEOUT_MS, MAX_TIMEOUT_RETRIES,
} from "./rick-api.mjs";
import { redactSecrets } from "./tools.mjs";

// ── NDJSON helpers ──────────────────────────────────────────────────────────

// Generation tracking — ensures only the latest request sends responses.
// currentGeneration: the highest generation number seen (from host or interrupt).
// processingGeneration: the generation of the message currently being processed.
let currentGeneration = 0;
let processingGeneration = 0;

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

/**
 * Check if the currently processing message has been superseded by a newer one.
 */
function isCurrentSuperseded() {
  return processingGeneration < currentGeneration;
}

function emitMessage(text) {
  // Don't emit if this message has been superseded
  if (isCurrentSuperseded()) return;
  emit({ type: "message", text: redactSecrets(text) });
}

function emitStatus(message) {
  // Don't emit if this message has been superseded
  if (isCurrentSuperseded()) return;
  emit({ type: "status", message: redactSecrets(message) });
}

function emitDone(result) {
  // Don't emit if this message has been superseded
  if (isCurrentSuperseded()) return;
  emit({ type: "done", result });
}

function emitWaitingUser(result) {
  // Don't emit if this message has been superseded
  if (isCurrentSuperseded()) return;
  emit({ type: "waiting_user", result });
}

function emitError(message) {
  // Don't emit if this message has been superseded
  if (isCurrentSuperseded()) return;
  emit({ type: "error", message: redactSecrets(message) });
}

function emitModelActive(modelId, modelName) {
  if (isCurrentSuperseded()) return;
  emit({ type: "model_active", modelId, modelName: redactSecrets(modelName) });
}

function emitProviderError(message) {
  if (isCurrentSuperseded()) return;
  emit({ type: "provider_error", message: redactSecrets(message) });
}

// ── Provider detection (dynamic — re-evaluated per turn) ────────────────────

// Cached tokens fetched from the host API at runtime.
// These supplement the static env vars for providers connected after session start.
let cachedClaudeToken = null;
let cachedOpenAIToken = null;

/**
 * Check if Claude is available (static API key OR dynamic OAuth token).
 */
function hasClaude() {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_ACCESS_TOKEN || cachedClaudeToken);
}

/**
 * Check if OpenAI is available (static API key OR dynamic OAuth token).
 */
function hasOpenAI() {
  return !!(process.env.OPENAI_API_KEY || process.env.OPENAI_ACCESS_TOKEN || cachedOpenAIToken);
}

/**
 * Check if Gemini is available (static API key only — no OAuth for Gemini).
 */
function hasGemini() {
  return !!process.env.GEMINI_API_KEY;
}

const MODEL_CHAIN = [
  { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { id: "gpt-5.3-codex", label: "GPT 5.3 Codex" },
  { id: "gemini-3.1-pro", label: "Gemini 3.1 Pro" },
  { id: "gemini-3.0-flash", label: "Gemini 3.0 Flash" },
];

const DEFAULT_MODEL_ID = "claude-opus-4-6";

function isSupportedModelId(value) {
  return MODEL_CHAIN.some((m) => m.id === value);
}

/**
 * Build the current list of available providers.
 */
function getProviderList() {
  const list = [];
  if (hasClaude()) list.push("claude-opus-4-6");
  if (hasOpenAI()) list.push("gpt-5.3-codex");
  if (hasGemini()) {
    list.push("gemini-3.1-pro");
    list.push("gemini-3.0-flash");
  }
  return list;
}

// Initial provider list (may expand after fetching fresh tokens)
const initialProviderList = getProviderList();

// ── Rick API helpers (imported from rick-api.mjs) ───────────────────────────
// rickApiGet, rickApiPost, agentToolHandler, buildAgentToolDeclarations,
// LLM_TIMEOUT_MS, MAX_TIMEOUT_RETRIES are all imported at the top.

/**
 * Refresh LLM tokens from the host API.
 * Called before each turn to get fresh OAuth tokens from the host (which handles
 * refresh-token rotation). Always fetches — even if static env vars exist — because
 * OAuth access tokens are short-lived and the env-var values injected at container
 * start may have expired.
 * Static API keys (ANTHROPIC_API_KEY, OPENAI_API_KEY) don't expire, so we skip
 * the fetch only when those are present.
 */
async function refreshLLMTokens({ force = false } = {}) {
  if (!process.env.RICK_API_URL || !process.env.RICK_SESSION_TOKEN) return;

  // Static API keys don't expire — no need to refresh.
  // OAuth tokens (ANTHROPIC_ACCESS_TOKEN, OPENAI_ACCESS_TOKEN) DO expire, so always refresh those.
  const needClaude = !process.env.ANTHROPIC_API_KEY;
  const needOpenAI = !process.env.OPENAI_API_KEY;

  const forceParam = force ? "&force=true" : "";
  const fetches = [];
  // Use silent: true to avoid showing 404 errors when OAuth is not configured
  if (needClaude) fetches.push(rickApiGet(`/api/agent/llm-token?provider=claude${forceParam}`, { silent: true }).then(d => ({ provider: "claude", data: d })));
  if (needOpenAI) fetches.push(rickApiGet(`/api/agent/llm-token?provider=openai${forceParam}`, { silent: true }).then(d => ({ provider: "openai", data: d })));

  const results = await Promise.allSettled(fetches);
  for (const r of results) {
    if (r.status !== "fulfilled" || !r.value.data) continue;
    const { provider, data } = r.value;
    if (data.accessToken) {
      if (provider === "claude") {
        cachedClaudeToken = data.accessToken;
      } else if (provider === "openai") {
        cachedOpenAIToken = data.accessToken;
        // Update account ID from host API (may be needed for ChatGPT-Account-Id header)
        if (data.accountId) {
          process.env.OPENAI_ACCOUNT_ID = data.accountId;
        }
      }
    }
  }
}

// ── Agent-specific tool handler (delegates to shared rick-api.mjs) ───────────

/** Wrapper that routes to shared tools + agent-specific tools */
async function runTool(name, input) {
  return executeTool(name, input, (n, i) => sharedAgentToolHandler(n, i, { emitStatus }));
}

// ── Agent name (used in tool descriptions and system prompt) ────────────────
const agentName = process.env.AGENT_NAME || "Rick";

// ── Tool declarations (core + agent-specific from rick-api.mjs) ─────────────
const toolDeclarations = [...coreToolDeclarations, ...buildAgentToolDeclarations(agentName)];

const toolNames = toolDeclarations.map((t) => t.name);

// ── System prompt ───────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Você é ${agentName} Sub-Agent, um agente autônomo executando dentro de um container Docker.

Sua tarefa é realizar o que o usuário pedir usando as ferramentas disponíveis.
Você mantém o contexto de toda a conversa — mensagens anteriores do usuário são lembradas.

REGRAS:
1. Responda sempre em português brasileiro.
2. Use as ferramentas para completar a tarefa. NÃO invente resultados.
3. Quando terminar uma etapa, emita um resumo claro do que foi feito.
4. Se precisar de informações adicionais, PERGUNTE DIRETAMENTE ao usuário (ex: "Qual a URL do repositório?") — você receberá a resposta na próxima mensagem. Fale sempre em segunda pessoa, direto com o usuário.
5. Se precisar de informações que o usuário já ensinou ao ${agentName} (credenciais, links de repositórios, preferências), use rick_memory (sem categoria para ver TUDO) ou rick_search (busca por significado).
6. SEMPRE consulte rick_memory antes de pedir informações ao usuário — a resposta pode já estar lá.
7. Credenciais estão disponíveis como variáveis de ambiente RICK_SECRET_* e GITHUB_TOKEN no container. Use \`run_command env\` para ver quais variáveis existem. Os valores de tokens/secrets são redatados por segurança — use a variável de ambiente diretamente nos comandos (ex: \`$GITHUB_TOKEN\`) em vez de tentar copiar o valor.
8. Para clonar repositórios Git PRIVADOS, use o GITHUB_TOKEN: \`git clone https://\${GITHUB_TOKEN}@github.com/org/repo.git\`. SEMPRE tente com o token antes de dizer que não tem acesso.
9. Para tarefas de código: clone o repositório, faça as alterações, rode testes se possível.
10. Para pesquisa web: use web_fetch para acessar URLs e extrair informações.
11. Seja conciso nas mensagens intermediárias, detalhado no resultado final.
12. NUNCA envie o output bruto de ferramentas como mensagem para o usuário. Resuma os resultados relevantes em vez de colar output extenso (como variáveis de ambiente, logs longos, etc.). O output das ferramentas já é registrado internamente.
13. Quando o usuário mencionar um projeto ou repositório por nome, consulte rick_memory ou rick_search para descobrir a URL antes de perguntar.
14. Quando o usuário ENSINAR algo útil (URLs, nomes de org, preferências, padrões de projeto), use rick_save_memory para salvar para futuros agentes. Exemplos: URL de organização GitHub, stack tecnológica preferida, convenções de código.

FERRAMENTAS DISPONÍVEIS: ${toolNames.join(", ")}`;

// ── Constants ───────────────────────────────────────────────────────────────

const FALLBACK_RESULT = "Tarefa concluída.";

// LLM_TIMEOUT_MS and MAX_TIMEOUT_RETRIES are imported from rick-api.mjs

// ── Gemini adapter ──────────────────────────────────────────────────────────

async function callGemini(contents, signal, modelId) {
  const apiKey = process.env.GEMINI_API_KEY;
  const MODEL = modelId === "gemini-3.0-flash" ? "gemini-3.0-flash" : "gemini-3.1-pro-preview";
  const BASE = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}`;
  const geminiTools = [{ functionDeclarations: toolDeclarations }];

  // Combine timeout with external abort signal
  const timeoutSignal = AbortSignal.timeout(LLM_TIMEOUT_MS);
  const combinedSignal = signal
    ? AbortSignal.any([timeoutSignal, signal])
    : timeoutSignal;

  const res = await fetch(`${BASE}:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: combinedSignal,
    body: JSON.stringify({
      contents,
      tools: geminiTools,
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const candidate = data.candidates?.[0];
  if (!candidate) throw new Error("Gemini retornou resposta vazia.");

  const parts = candidate.content.parts ?? [];
  return {
    texts: parts.filter((p) => p.text).map((p) => p.text),
    toolCalls: parts
      .filter((p) => p.functionCall)
      .map((p) => ({ name: p.functionCall.name, input: p.functionCall.args ?? {} })),
    modelParts: parts,
  };
}

// Module-level conversation histories — persist between turns
let geminiHistory = [];
let openaiHistory = null; // initialized on first use
let claudeHistory = [];

/**
 * Provider-agnostic conversation transcript.
 * Stores { role: "user"|"assistant", content: "..." } for each successful turn.
 * Used to seed a provider's history when the cascade falls through to it for the first time.
 * This prevents amnesia when switching providers mid-session.
 */
const conversationTranscript = [];

/**
 * Seed a provider's history with the conversation transcript (if empty).
 * Called before starting a provider loop when the provider has no history
 * but we have context from other providers' successful turns.
 */
function seedProviderHistory(providerName) {
  if (conversationTranscript.length === 0) return;

  if (providerName === "Gemini" && geminiHistory.length === 0) {
    for (const m of conversationTranscript) {
      const role = m.role === "user" ? "user" : "model";
      geminiHistory.push({ role, parts: [{ text: m.content }] });
    }
  } else if (providerName === "OpenAI" && (!openaiHistory || openaiHistory.length <= 1)) {
    // openaiHistory[0] is the system message; only seed if no conversation yet
    if (!openaiHistory) openaiHistory = [{ role: "system", content: SYSTEM_PROMPT }];
    for (const m of conversationTranscript) {
      const role = m.role === "user" ? "user" : "assistant";
      openaiHistory.push({ role, content: m.content });
    }
  } else if (providerName === "Claude" && claudeHistory.length === 0) {
    for (const m of conversationTranscript) {
      const role = m.role === "user" ? "user" : "assistant";
      claudeHistory.push({ role, content: m.content });
    }
  }
}

// Interrupt handling — allows cancelling the current LLM request
let currentAbortController = null;
let interruptRequested = false;

async function runGeminiLoop(userText, signal, modelId) {
  // Remember history length so we can roll back on error.
  // This prevents dangling user messages that break alternation requirements.
  const historyLenBefore = geminiHistory.length;
  geminiHistory.push({ role: "user", parts: [{ text: userText }] });
  let contents = geminiHistory;

  try {
    while (true) {
      // Check for interrupt before making LLM call
      if (signal?.aborted || interruptRequested) {
        throw new Error("Interrupted");
      }

      const { texts, toolCalls, modelParts } = await callGemini(contents, signal, modelId);
      contents.push({ role: "model", parts: modelParts });

      for (const text of texts) {
        emitMessage(text);
      }

      if (toolCalls.length === 0) {
        return texts.join("\n") || FALLBACK_RESULT;
      }

      const toolResults = [];
      for (const tc of toolCalls) {
        if (signal?.aborted || interruptRequested) {
          throw new Error("Interrupted");
        }
        emitStatus(toolStatusLabel(tc.name, tc.input));
        const result = await runTool(tc.name, tc.input);
        toolResults.push({ name: tc.name, result: String(result) });
      }

      contents.push({
        role: "user",
        parts: toolResults.map((r) => ({
          functionResponse: { name: r.name, response: { result: r.result } },
        })),
      });
    }
  } catch (err) {
    // Roll back history to prevent dangling user messages that break
    // the user→model alternation required by the Gemini API.
    geminiHistory.length = historyLenBefore;
    throw err;
  }
}

// ── OpenAI adapter ──────────────────────────────────────────────────────────

// Codex Responses API endpoint — used when authenticating via OAuth
// (user's ChatGPT Pro/Plus subscription). Same endpoint opencode uses.
const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

async function runOpenAILoop(userText, signal) {
  const apiKey = process.env.OPENAI_API_KEY ?? "";
  // Prefer dynamically cached token (freshly refreshed from host API) over
  // the static env var which may have expired since container start.
  const oauthToken = cachedOpenAIToken || process.env.OPENAI_ACCESS_TOKEN || "";
  const token = oauthToken || apiKey;
  if (!token) {
    throw new Error("OpenAI: nenhum token disponível");
  }

  // When using OAuth, we must use the Codex Responses API at chatgpt.com
  // (not api.openai.com which rejects ChatGPT OAuth tokens).
  const useCodexApi = !!oauthToken && !apiKey;

  if (useCodexApi) {
    return runOpenAICodexLoop(userText, oauthToken, signal);
  }

  // Standard API key mode — Chat Completions API
  const authHeader = `Bearer ${token}`;
  const openaiTools = toolDeclarations.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  if (!openaiHistory) {
    openaiHistory = [{ role: "system", content: SYSTEM_PROMPT }];
  }
  // Remember history length so we can roll back on error
  const historyLenBefore = openaiHistory.length;
  openaiHistory.push({ role: "user", content: userText });
  let messages = openaiHistory;

  try {
    while (true) {
      // Check for interrupt before making LLM call
      if (signal?.aborted || interruptRequested) {
        throw new Error("Interrupted");
      }

      // Combine timeout with external abort signal
      const timeoutSignal = AbortSignal.timeout(LLM_TIMEOUT_MS);
      const combinedSignal = signal
        ? AbortSignal.any([timeoutSignal, signal])
        : timeoutSignal;

      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        signal: combinedSignal,
        headers: {
          "Content-Type": "application/json",
          Authorization: authHeader,
          ...(process.env.OPENAI_ACCOUNT_ID ? { "OpenAI-Organization": process.env.OPENAI_ACCOUNT_ID } : {}),
        },
        body: JSON.stringify({ model: "gpt-5.3-codex", messages, tools: openaiTools }),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`OpenAI API error ${res.status}: ${errText}`);
      }

      const data = await res.json();
      const choice = data.choices[0];
      const msg = choice.message;
      messages.push(msg);

      if (msg.content) emitMessage(msg.content);

      const toolCalls = (msg.tool_calls ?? []).map((tc) => ({
        name: tc.function.name,
        input: (() => { try { return JSON.parse(tc.function.arguments); } catch { return {}; } })(),
        id: tc.id,
      }));

      if (toolCalls.length === 0) {
        return msg.content || FALLBACK_RESULT;
      }

      for (const tc of toolCalls) {
        if (signal?.aborted || interruptRequested) {
          throw new Error("Interrupted");
        }
        emitStatus(toolStatusLabel(tc.name, tc.input));
        const result = await runTool(tc.name, tc.input);
        messages.push({ role: "tool", tool_call_id: tc.id, content: String(result) });
      }
    }
  } catch (err) {
    // Roll back history to prevent inconsistent state (dangling user message
    // without assistant response) that causes amnesia on the next turn.
    openaiHistory.length = historyLenBefore;
    throw err;
  }
}

/**
 * OAuth mode — Codex Responses API at chatgpt.com
 * Uses the OpenAI Responses API format (not Chat Completions).
 * Same approach as opencode's codex auth plugin.
 */
async function runOpenAICodexLoop(userText, oauthToken, signal) {
  const accountId = process.env.OPENAI_ACCOUNT_ID || "";

  // Build Responses API input format
  const input = [];
  // Add system prompt as developer instructions (Responses API uses top-level `instructions`)
  // Add conversation history from transcript if we have prior context
  if (!openaiHistory) {
    openaiHistory = [{ role: "system", content: SYSTEM_PROMPT }];
  }
  const historyLenBefore = openaiHistory.length;
  openaiHistory.push({ role: "user", content: userText });

  // Build Responses API input from history (skip system message at index 0)
  for (let i = 1; i < openaiHistory.length; i++) {
    const m = openaiHistory[i];
    if (m.role === "user") {
      input.push({ role: "user", content: [{ type: "input_text", text: m.content }] });
    } else if (m.role === "assistant") {
      input.push({ role: "assistant", content: [{ type: "output_text", text: m.content }] });
    }
    // Skip system and tool messages in Responses API format
  }

  // Define tools in Responses API format
  const responsesTools = toolDeclarations.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));

  try {
    while (true) {
      if (signal?.aborted || interruptRequested) {
        throw new Error("Interrupted");
      }

      const timeoutSignal = AbortSignal.timeout(LLM_TIMEOUT_MS);
      const combinedSignal = signal
        ? AbortSignal.any([timeoutSignal, signal])
        : timeoutSignal;

      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${oauthToken}`,
        "User-Agent": "rick-ai/1.0",
        originator: "opencode",
      };
      if (accountId) {
        headers["ChatGPT-Account-Id"] = accountId;
      }

      const body = {
        model: "gpt-5.3-codex",
        instructions: SYSTEM_PROMPT,
        input,
        tools: responsesTools,
        store: false,
        stream: false,
      };

      const res = await fetch(CODEX_API_ENDPOINT, {
        method: "POST",
        signal: combinedSignal,
        headers,
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`OpenAI Codex API error ${res.status}: ${errText}`);
      }

      const data = await res.json();

      // Parse Responses API output
      let text = "";
      const toolCalls = [];

      if (data.output && Array.isArray(data.output)) {
        for (const item of data.output) {
          if (item.type === "message" && item.content) {
            for (const part of item.content) {
              if (part.type === "output_text") {
                text += part.text;
              }
            }
          }
          if (item.type === "function_call") {
            toolCalls.push({
              name: item.name,
              input: (() => { try { return JSON.parse(item.arguments); } catch { return {}; } })(),
              callId: item.call_id,
            });
          }
        }
      }

      if (text) emitMessage(text);

      if (toolCalls.length === 0) {
        // Update openaiHistory with the assistant response for future turns
        if (text) openaiHistory.push({ role: "assistant", content: text });
        return text || FALLBACK_RESULT;
      }

      // Execute tool calls and build function_call_output items for next request
      for (const tc of toolCalls) {
        if (signal?.aborted || interruptRequested) {
          throw new Error("Interrupted");
        }
        emitStatus(toolStatusLabel(tc.name, tc.input));
        const result = await runTool(tc.name, tc.input);

        // Add function call + output to the input for next iteration
        input.push({
          type: "function_call",
          name: tc.name,
          arguments: JSON.stringify(tc.input),
          call_id: tc.callId,
        });
        input.push({
          type: "function_call_output",
          call_id: tc.callId,
          output: String(result),
        });
      }
    }
  } catch (err) {
    openaiHistory.length = historyLenBefore;
    throw err;
  }
}

// ── Claude API adapter ──────────────────────────────────────────────────────

// Tool name prefix required by Anthropic's OAuth/beta endpoint.
// The server requires tool names to start with "mcp_" when using OAuth tokens.
// Same approach as opencode's anthropic-auth plugin.
const CLAUDE_OAUTH_TOOL_PREFIX = "mcp_";

async function runClaudeLoop(userText, signal) {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  // Prefer dynamically cached token (freshly refreshed from host API) over
  // the static env var which may have expired since container start.
  const oauthToken = cachedClaudeToken || process.env.ANTHROPIC_ACCESS_TOKEN || "";
  const useOAuth = !!oauthToken && !apiKey;

  const claudeTools = toolDeclarations.map((t) => ({
    name: useOAuth ? `${CLAUDE_OAUTH_TOOL_PREFIX}${t.name}` : t.name,
    description: t.description,
    input_schema: t.parameters,
  }));

  // Remember history length so we can roll back on error
  const historyLenBefore = claudeHistory.length;
  claudeHistory.push({ role: "user", content: userText });
  let messages = claudeHistory;

  // For OAuth mode, prefix tool names in existing history's tool_use/tool_result blocks
  // so the API sees consistent mcp_ prefixed names throughout
  const messagesForApi = useOAuth ? prefixToolNamesInMessages(messages) : messages;

  try {
    while (true) {
      // Check for interrupt before making LLM call
      if (signal?.aborted || interruptRequested) {
        throw new Error("Interrupted");
      }

      const headers = {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      };
      if (useOAuth) {
        headers["Authorization"] = `Bearer ${oauthToken}`;
        // Required beta header for OAuth authentication support
        headers["anthropic-beta"] = "oauth-2025-04-20,interleaved-thinking-2025-05-14";
        // Identify as Claude CLI (required by OAuth endpoint)
        headers["user-agent"] = "claude-cli/2.1.2 (external, cli)";
      } else if (apiKey) {
        headers["x-api-key"] = apiKey;
      } else {
        throw new Error("Claude: nenhum token disponível");
      }

      // Combine timeout with external abort signal
      const timeoutSignal = AbortSignal.timeout(LLM_TIMEOUT_MS);
      const combinedSignal = signal
        ? AbortSignal.any([timeoutSignal, signal])
        : timeoutSignal;

      // Sanitize system prompt for OAuth mode — the server blocks non-Claude branding
      const systemPrompt = useOAuth
        ? SYSTEM_PROMPT.replace(/Rick Sub-Agent/g, "Claude Code").replace(/Rick/g, "Claude")
        : SYSTEM_PROMPT;

      // Build URL — OAuth mode requires ?beta=true query param
      const apiUrl = useOAuth
        ? "https://api.anthropic.com/v1/messages?beta=true"
        : "https://api.anthropic.com/v1/messages";

      const res = await fetch(apiUrl, {
        method: "POST",
        signal: combinedSignal,
        headers,
        body: JSON.stringify({
          model: "claude-opus-4-6",
          max_tokens: 8192,
          system: systemPrompt,
          messages: messagesForApi,
          tools: claudeTools,
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Claude API error ${res.status}: ${errText}`);
      }

      const data = await res.json();

      // Strip mcp_ prefix from tool names in the response before storing in history
      const content = useOAuth ? stripToolPrefixFromContent(data.content) : data.content;
      messages.push({ role: "assistant", content });

      const textBlocks = content.filter((b) => b.type === "text");
      const toolBlocks = content.filter((b) => b.type === "tool_use");

      for (const tb of textBlocks) {
        emitMessage(tb.text);
      }

      if (toolBlocks.length === 0) {
        return textBlocks.map((b) => b.text).join("\n") || FALLBACK_RESULT;
      }

      const toolResults = [];
      for (const tb of toolBlocks) {
        if (signal?.aborted || interruptRequested) {
          throw new Error("Interrupted");
        }
        emitStatus(toolStatusLabel(tb.name, tb.input));
        const result = await runTool(tb.name, tb.input);
        toolResults.push({ type: "tool_result", tool_use_id: tb.id, content: String(result) });
      }

      messages.push({ role: "user", content: toolResults });
      // For OAuth, the messagesForApi reference is the same as messages after prefix transformation,
      // but since we strip on receive and re-prefix on send, update the reference
      if (useOAuth) {
        // Rebuild the prefixed messages for the next API call
        messagesForApi.length = 0;
        messagesForApi.push(...prefixToolNamesInMessages(messages));
      }
    }
  } catch (err) {
    // Roll back history to prevent dangling user messages that break
    // the user→assistant alternation required by the Claude API.
    claudeHistory.length = historyLenBefore;
    throw err;
  }
}

/**
 * Prefix tool names in messages for OAuth mode.
 * Deep-clones messages and adds mcp_ prefix to tool_use and tool_result names.
 */
function prefixToolNamesInMessages(messages) {
  return messages.map((msg) => {
    if (!msg.content || !Array.isArray(msg.content)) return msg;
    return {
      ...msg,
      content: msg.content.map((block) => {
        if (block.type === "tool_use" && block.name && !block.name.startsWith(CLAUDE_OAUTH_TOOL_PREFIX)) {
          return { ...block, name: `${CLAUDE_OAUTH_TOOL_PREFIX}${block.name}` };
        }
        return block;
      }),
    };
  });
}

/**
 * Strip mcp_ prefix from tool names in response content.
 */
function stripToolPrefixFromContent(content) {
  if (!Array.isArray(content)) return content;
  return content.map((block) => {
    if (block.type === "tool_use" && block.name && block.name.startsWith(CLAUDE_OAUTH_TOOL_PREFIX)) {
      return { ...block, name: block.name.slice(CLAUDE_OAUTH_TOOL_PREFIX.length) };
    }
    return block;
  });
}

// ── Main: stdin/stdout event loop ───────────────────────────────────────────

if (initialProviderList.length === 0) {
  emitError("Nenhum provedor de LLM disponível. Configure GEMINI_API_KEY, OPENAI_API_KEY, ou ANTHROPIC_API_KEY.");
  process.exit(1);
}

// Emit ready signal (initial providers — may expand after refreshLLMTokens)
emit({ type: "ready", providers: initialProviderList, models: MODEL_CHAIN, tools: toolNames });

// Read messages from stdin (NDJSON, one per line)
const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", async (line) => {
  let msg;
  try {
    msg = JSON.parse(line.trim());
  } catch {
    return; // Ignore malformed input
  }

  if (msg.type === "ping") {
    emit({ type: "pong" });
    return;
  }

  // Handle interrupt message — abort the current LLM request
  if (msg.type === "interrupt") {
    // Update generation so in-flight responses are discarded
    if (msg.generation !== undefined) {
      currentGeneration = msg.generation;
    }
    if (currentAbortController) {
      interruptRequested = true;
      currentAbortController.abort();
      currentAbortController = null;
      emitStatus("Operação interrompida pelo usuário");
    }
    return;
  }

  // Update auth/runtime API data for recovered sessions.
  if (msg.type === "update_token" && msg.token) {
    process.env.RICK_SESSION_TOKEN = msg.token;
    if (typeof msg.apiUrl === "string" && msg.apiUrl.trim()) {
      process.env.RICK_API_URL = msg.apiUrl.trim();
    }
    emit({ type: "token_updated" });
    return;
  }

  // Restore conversation history (sent by host after recovery or process restart).
  // Each entry: { role: "user"|"agent", content: "..." }
  if (msg.type === "history" && Array.isArray(msg.messages)) {
    for (const m of msg.messages) {
      const role = m.role === "user" ? "user" : "model";
      if (hasGemini()) {
        geminiHistory.push({ role, parts: [{ text: m.content }] });
      }
      if (hasOpenAI() || hasClaude()) {
        const oaRole = m.role === "user" ? "user" : "assistant";
        if (hasOpenAI()) {
          if (!openaiHistory) openaiHistory = [{ role: "system", content: SYSTEM_PROMPT }];
          openaiHistory.push({ role: oaRole, content: m.content });
        }
        if (hasClaude()) {
          claudeHistory.push({ role: oaRole, content: m.content });
        }
      }
      // Also populate the provider-agnostic transcript for cascade seeding
      const transcriptRole = m.role === "user" ? "user" : "assistant";
      conversationTranscript.push({ role: transcriptRole, content: m.content });
    }
    emit({ type: "history_loaded", count: msg.messages.length });
    return;
  }

  if (msg.type !== "message" || !msg.text) return;

  const userText = msg.text;
  const selectedModelId = isSupportedModelId(msg.model) ? msg.model : DEFAULT_MODEL_ID;
  
  // Track generation for this message (if provided by host)
  const messageGeneration = msg.generation ?? (currentGeneration + 1);
  currentGeneration = messageGeneration;
  processingGeneration = messageGeneration; // Set for emit functions to check

  // Reset interrupt state for new message
  interruptRequested = false;
  currentAbortController = new AbortController();
  let signal = currentAbortController.signal;

  // Helper to check if this message has been superseded
  const isSuperseded = () => messageGeneration < currentGeneration;

  // Refresh LLM tokens from host API — detects providers connected after session start.
  // This is async but runs quickly (parallel fetches with 5s timeout).
  await refreshLLMTokens();

  // Check if superseded after token refresh
  if (isSuperseded()) {
    currentAbortController = null;
    return;
  }

  // Provider cascade: start from selected model, then continue in chain order.
  // Re-evaluated per turn to detect providers added since session start.
  const availability = {
    "claude-opus-4-6": hasClaude(),
    "gpt-5.3-codex": hasOpenAI(),
    "gemini-3.1-pro": hasGemini(),
    "gemini-3.0-flash": hasGemini(),
  };

  const selectedIndex = MODEL_CHAIN.findIndex((m) => m.id === selectedModelId);
  const orderedModels = selectedIndex >= 0
    ? MODEL_CHAIN.slice(selectedIndex).concat(MODEL_CHAIN.slice(0, selectedIndex))
    : MODEL_CHAIN;

  const cascade = [];
  for (const model of orderedModels) {
    if (!availability[model.id]) continue;
    if (model.id === "claude-opus-4-6") {
      cascade.push({
        modelId: model.id,
        name: model.label,
        seedName: "Claude",
        fn: (text, sig) => runClaudeLoop(text, sig),
      });
    } else if (model.id === "gpt-5.3-codex") {
      cascade.push({
        modelId: model.id,
        name: model.label,
        seedName: "OpenAI",
        fn: (text, sig) => runOpenAILoop(text, sig),
      });
    } else if (model.id === "gemini-3.1-pro") {
      cascade.push({
        modelId: model.id,
        name: model.label,
        seedName: "Gemini",
        fn: (text, sig) => runGeminiLoop(text, sig, "gemini-3.1-pro"),
      });
    } else if (model.id === "gemini-3.0-flash") {
      cascade.push({
        modelId: model.id,
        name: model.label,
        seedName: "Gemini",
        fn: (text, sig) => runGeminiLoop(text, sig, "gemini-3.0-flash"),
      });
    }
  }

  if (cascade.length === 0) {
    emitError("Nenhum provedor de LLM disponível. Conecte Claude, OpenAI ou Gemini no painel de configurações.");
    currentAbortController = null;
    return;
  }

  let result;
  let lastErr;
  for (let providerIndex = 0; providerIndex < cascade.length; providerIndex++) {
    const provider = cascade[providerIndex];
    // Seed provider history with transcript from other providers (prevents amnesia on cascade switch)
    seedProviderHistory(provider.seedName);

    let attempts = 0;
    let authRetried = false; // auth refresh retry is separate from timeout retries
    const maxAttempts = 1 + MAX_TIMEOUT_RETRIES; // 1 initial + N timeout retries
    while (attempts < maxAttempts) {
      attempts++;
      try {
        emitStatus(`Modelo atual: ${provider.name}`);
        emitModelActive(provider.modelId, provider.name);
        result = await provider.fn(userText, signal);
        lastErr = null;
        break;
      } catch (err) {
        // Check if this was an interrupt (not a provider failure)
        if (err.message === "Interrupted" || signal.aborted || interruptRequested) {
          // Interrupted by user — emit waiting_user so UI shows compose bar
          currentAbortController = null;
          // Only emit if this is still the latest generation
          if (!isSuperseded()) {
            emitWaitingUser("(processamento interrompido)");
          }
          return;
        }

        lastErr = err;
        // Detect timeout errors. AbortSignal.timeout() throws TimeoutError; when wrapped
        // in AbortSignal.any(), it may surface as AbortError with a TimeoutError reason.
        // We only treat AbortError as timeout if the user did NOT trigger the abort
        // (interruptRequested is false and currentAbortController.signal is not aborted).
        const isTimeout = err.name === "TimeoutError"
          || (err.name === "AbortError" && !interruptRequested && !signal.aborted)
          || err.message?.includes("timed out")
          || err.message?.includes("timeout");

        if (isTimeout && attempts < maxAttempts) {
          // Retry on timeout — the LLM may just be slow this time
          process.stderr.write(`Provedor ${provider.name} timeout (tentativa ${attempts}/${maxAttempts}), retentando...\n`);
          emitStatus(`${provider.name} demorou — retentando...`);
          // Need a fresh AbortController for the retry (the old one's signal may be timed out)
          currentAbortController = new AbortController();
          signal = currentAbortController.signal;
          continue;
        }

        // Detect auth errors (401) — OAuth token may have expired mid-session.
        // Refresh the token from the host API and retry this provider once.
        // Auth retry is tracked separately from timeout retries so both can
        // fire independently (e.g. timeout → auth error → refreshed success).
        const isAuthError = err.message?.includes("API error 401")
          || err.message?.includes("authentication_error")
          || err.message?.includes("Invalid bearer token")
          || err.message?.includes("invalid_api_key");

        if (isAuthError && !authRetried) {
          authRetried = true;
          attempts--; // don't consume a timeout-retry slot for auth refresh
          process.stderr.write(`Provedor ${provider.name} auth error, force-refreshing token...\n`);
          emitStatus(`${provider.name} token expirado — renovando...`);
          // Force refresh bypasses the host's cache and DB expiry check,
          // using the refresh-token flow to get a genuinely new access token.
          await refreshLLMTokens({ force: true });
          continue;
        }

        process.stderr.write(`Provedor ${provider.name} falhou: ${err.message}\n`);
        const nextProvider = cascade[providerIndex + 1];
        if (nextProvider) {
          emitProviderError(`${provider.name} falhou: ${err.message}. Tentando ${nextProvider.name}.`);
        }
        break; // Move to next provider
      }
    }
    if (!lastErr) break; // Success — stop cascade
  }

  currentAbortController = null;

  // Check if superseded before emitting response
  if (isSuperseded()) {
    return;
  }

  if (lastErr) {
    emitError(lastErr.message || "Erro desconhecido no sub-agente.");
  } else {
    // Record successful turn in provider-agnostic transcript (for cascade seeding)
    conversationTranscript.push({ role: "user", content: userText });
    if (result && result !== FALLBACK_RESULT) {
      conversationTranscript.push({ role: "assistant", content: result });
    }
    // Signal that we're done processing this turn but ready for more input.
    // The session stays alive — the host will show the compose bar again.
    emitWaitingUser(result);
  }
});

rl.on("close", () => {
  process.exit(0);
});
