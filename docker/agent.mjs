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
  emit({ type: "message", text });
}

function emitStatus(message) {
  // Don't emit if this message has been superseded
  if (isCurrentSuperseded()) return;
  emit({ type: "status", message });
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
  emit({ type: "error", message });
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

/**
 * Build the current list of available providers.
 */
function getProviderList() {
  const list = [];
  if (hasClaude()) list.push("claude");
  if (hasOpenAI()) list.push("openai");
  if (hasGemini()) list.push("gemini");
  return list;
}

// Initial provider list (may expand after fetching fresh tokens)
const initialProviderList = getProviderList();

// ── Rick API client (for querying memories/credentials) ─────────────────────

const RICK_API_URL = process.env.RICK_API_URL || "";
const RICK_SESSION_TOKEN = process.env.RICK_SESSION_TOKEN || "";

async function rickApiGet(path) {
  if (!RICK_API_URL || !RICK_SESSION_TOKEN) {
    emitStatus("rick_memory/rick_search indisponível: RICK_API_URL ou RICK_SESSION_TOKEN não configurado");
    return null;
  }
  try {
    const res = await fetch(`${RICK_API_URL}${path}`, {
      headers: { Authorization: `Bearer ${RICK_SESSION_TOKEN}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      emitStatus(`rick API erro: ${res.status} ${res.statusText}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    emitStatus(`rick API falhou: ${err.message || "timeout/rede"}`);
    return null;
  }
}

async function rickApiPost(path, body) {
  if (!RICK_API_URL || !RICK_SESSION_TOKEN) {
    return { error: "RICK_API_URL ou RICK_SESSION_TOKEN não configurado" };
  }
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
    if (!res.ok) {
      return { error: data.error || `HTTP ${res.status}` };
    }
    return data;
  } catch (err) {
    return { error: err.message || "timeout/rede" };
  }
}

/**
 * Refresh LLM tokens from the host API.
 * Called before each turn to detect providers connected after session start.
 * Updates cachedClaudeToken / cachedOpenAIToken so has*() functions return true.
 */
async function refreshLLMTokens() {
  if (!RICK_API_URL || !RICK_SESSION_TOKEN) return;

  // Only fetch if we don't have static keys (OAuth is the only dynamic source)
  const needClaude = !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_ACCESS_TOKEN;
  const needOpenAI = !process.env.OPENAI_API_KEY && !process.env.OPENAI_ACCESS_TOKEN;

  const fetches = [];
  if (needClaude) fetches.push(rickApiGet("/api/agent/llm-token?provider=claude").then(d => ({ provider: "claude", data: d })));
  if (needOpenAI) fetches.push(rickApiGet("/api/agent/llm-token?provider=openai").then(d => ({ provider: "openai", data: d })));

  const results = await Promise.allSettled(fetches);
  for (const r of results) {
    if (r.status !== "fulfilled" || !r.value.data) continue;
    const { provider, data } = r.value;
    if (data.accessToken) {
      if (provider === "claude") {
        cachedClaudeToken = data.accessToken;
      } else if (provider === "openai") {
        cachedOpenAIToken = data.accessToken;
      }
    }
  }
}

// ── Agent-specific tool handler (web_fetch, rick_memory, rick_search) ────────

async function agentToolHandler(name, input) {
  switch (name) {
    case "web_fetch": {
      try {
        const res = await fetch(input.url, { signal: AbortSignal.timeout(15000) });
        const text = await res.text();
        return text.length > 20000 ? text.substring(0, 20000) + "\n...(truncado)" : text;
      } catch (e) {
        return `Erro ao acessar ${input.url}: ${e.message}`;
      }
    }
    case "rick_memory": {
      const data = await rickApiGet(`/api/agent/memories${input.category ? `?category=${encodeURIComponent(input.category)}` : ""}`);
      if (!data) return "Não foi possível acessar as memórias do assistente.";
      return JSON.stringify(data.memories || [], null, 2);
    }
    case "rick_search": {
      const data = await rickApiGet(`/api/agent/search?q=${encodeURIComponent(input.query)}&limit=${input.limit || 5}`);
      if (!data) return "Busca semântica não disponível no assistente.";
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
    default:
      return undefined; // fall through to "unknown tool"
  }
}

/** Wrapper that routes to shared tools + agent-specific tools */
async function runTool(name, input) {
  return executeTool(name, input, agentToolHandler);
}

// ── Agent name (used in tool descriptions and system prompt) ────────────────
const agentName = process.env.AGENT_NAME || "Rick";

// ── Tool declarations (core + agent-specific) ───────────────────────────────

const toolDeclarations = [
  ...coreToolDeclarations,
  {
    name: "web_fetch",
    description: "Faz uma requisição HTTP GET e retorna o conteúdo da página",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "URL para acessar" } },
      required: ["url"],
    },
  },
  {
    name: "rick_memory",
    description: `Lista memórias salvas pelo ${agentName} (credenciais, links, preferências, informações do usuário). Sem categoria retorna TODAS as memórias. USE ESTA FERRAMENTA PRIMEIRO quando precisar de informações que o usuário já tenha ensinado.`,
    parameters: {
      type: "object",
      properties: { category: { type: "string", description: "Categoria opcional para filtrar. Categorias comuns: credenciais, senhas, geral, pessoal, notas, preferências. Omita para listar TODAS." } },
    },
  },
  {
    name: "rick_search",
    description: `Busca semântica nas conversas e memórias do ${agentName}. Use quando precisar encontrar algo específico por significado (ex: 'repositório zydon', 'email do cliente').`,
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
    description: `Salva uma informação na memória persistente do ${agentName}. Use quando o usuário ensinar algo útil (URLs de repositórios, preferências, nomes de projetos, padrões, etc.) para que outros agentes futuros possam consultar. NÃO use para credenciais/senhas — essas são protegidas.`,
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "Identificador curto da memória (ex: 'github_org_zydon', 'preferencia_linguagem')" },
        value: { type: "string", description: "Valor a salvar (ex: 'https://github.com/zydontecnologia', 'TypeScript com NestJS')" },
        category: { type: "string", description: "Categoria: geral, notas, preferencias, projetos, links. Padrão: geral. NÃO use: credenciais, tokens, senhas." },
      },
      required: ["key", "value"],
    },
  },
];

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
7. Credenciais estão disponíveis como variáveis de ambiente RICK_SECRET_* e GITHUB_TOKEN no container. Use \`run_command env\` para listar TODAS as variáveis disponíveis.
8. Para clonar repositórios Git PRIVADOS, use o GITHUB_TOKEN: \`git clone https://\${GITHUB_TOKEN}@github.com/org/repo.git\`. SEMPRE tente com o token antes de dizer que não tem acesso.
9. Para tarefas de código: clone o repositório, faça as alterações, rode testes se possível.
10. Para pesquisa web: use web_fetch para acessar URLs e extrair informações.
11. Seja conciso nas mensagens intermediárias, detalhado no resultado final.
12. Quando o usuário mencionar um projeto ou repositório por nome, consulte rick_memory ou rick_search para descobrir a URL antes de perguntar.
13. Quando o usuário ENSINAR algo útil (URLs, nomes de org, preferências, padrões de projeto), use rick_save_memory para salvar para futuros agentes. Exemplos: URL de organização GitHub, stack tecnológica preferida, convenções de código.

FERRAMENTAS DISPONÍVEIS: ${toolNames.join(", ")}`;

// ── Constants ───────────────────────────────────────────────────────────────

const FALLBACK_RESULT = "Tarefa concluída.";

// ── Gemini adapter ──────────────────────────────────────────────────────────

async function callGemini(contents, signal) {
  const apiKey = process.env.GEMINI_API_KEY;
  const MODEL = "gemini-3.1-pro-preview";
  const BASE = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}`;
  const geminiTools = [{ functionDeclarations: toolDeclarations }];

  // Combine timeout with external abort signal
  const timeoutSignal = AbortSignal.timeout(120_000);
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

// Interrupt handling — allows cancelling the current LLM request
let currentAbortController = null;
let interruptRequested = false;

async function runGeminiLoop(userText, signal) {
  geminiHistory.push({ role: "user", parts: [{ text: userText }] });
  let contents = geminiHistory;

  while (true) {
    // Check for interrupt before making LLM call
    if (signal?.aborted || interruptRequested) {
      throw new Error("Interrupted");
    }

    const { texts, toolCalls, modelParts } = await callGemini(contents, signal);
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
}

// ── OpenAI adapter ──────────────────────────────────────────────────────────

async function runOpenAILoop(userText, signal) {
  const apiKey = process.env.OPENAI_API_KEY ?? "";
  // Prefer static OAuth token, fall back to dynamically cached token
  const oauthToken = process.env.OPENAI_ACCESS_TOKEN || cachedOpenAIToken || "";
  const token = oauthToken || apiKey;
  if (!token) {
    throw new Error("OpenAI: nenhum token disponível");
  }
  const authHeader = `Bearer ${token}`;
  const openaiTools = toolDeclarations.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  if (!openaiHistory) {
    openaiHistory = [{ role: "system", content: SYSTEM_PROMPT }];
  }
  openaiHistory.push({ role: "user", content: userText });
  let messages = openaiHistory;

  while (true) {
    // Check for interrupt before making LLM call
    if (signal?.aborted || interruptRequested) {
      throw new Error("Interrupted");
    }

    // Combine timeout with external abort signal
    const timeoutSignal = AbortSignal.timeout(120_000);
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
}

// ── Claude API adapter ──────────────────────────────────────────────────────

async function runClaudeLoop(userText, signal) {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  // Prefer static OAuth token, fall back to dynamically cached token
  const oauthToken = process.env.ANTHROPIC_ACCESS_TOKEN || cachedClaudeToken || "";
  const claudeTools = toolDeclarations.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));

  claudeHistory.push({ role: "user", content: userText });
  let messages = claudeHistory;

  while (true) {
    // Check for interrupt before making LLM call
    if (signal?.aborted || interruptRequested) {
      throw new Error("Interrupted");
    }

    const headers = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    if (oauthToken) {
      headers["Authorization"] = `Bearer ${oauthToken}`;
    } else if (apiKey) {
      headers["x-api-key"] = apiKey;
    } else {
      throw new Error("Claude: nenhum token disponível");
    }

    // Combine timeout with external abort signal
    const timeoutSignal = AbortSignal.timeout(120_000);
    const combinedSignal = signal
      ? AbortSignal.any([timeoutSignal, signal])
      : timeoutSignal;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: combinedSignal,
      headers,
      body: JSON.stringify({
        model: "claude-opus-4-6",
        max_tokens: 8192,
        system: SYSTEM_PROMPT,
        messages,
        tools: claudeTools,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Claude API error ${res.status}: ${errText}`);
    }

    const data = await res.json();
    messages.push({ role: "assistant", content: data.content });

    const textBlocks = data.content.filter((b) => b.type === "text");
    const toolBlocks = data.content.filter((b) => b.type === "tool_use");

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
  }
}

// ── Main: stdin/stdout event loop ───────────────────────────────────────────

if (initialProviderList.length === 0) {
  emitError("Nenhum provedor de LLM disponível. Configure GEMINI_API_KEY, OPENAI_API_KEY, ou ANTHROPIC_API_KEY.");
  process.exit(1);
}

// Emit ready signal (initial providers — may expand after refreshLLMTokens)
emit({ type: "ready", providers: initialProviderList, tools: toolNames });

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

  // Update session token (sent by host after recovery when JWT secret changed).
  // This allows the agent to continue making API calls with a valid token.
  if (msg.type === "update_token" && msg.token) {
    process.env.RICK_SESSION_TOKEN = msg.token;
    emit({ type: "token_updated" });
    return;
  }

  // Restore conversation history (sent by host after recovery or process restart).
  // Each entry: { role: "user"|"agent", content: "..." }
  if (msg.type === "history" && Array.isArray(msg.messages)) {
    for (const m of msg.messages) {
      const role = m.role === "user" ? "user" : "model";
      if (hasGemini) {
        geminiHistory.push({ role, parts: [{ text: m.content }] });
      }
      if (hasOpenAI || hasClaude) {
        const oaRole = m.role === "user" ? "user" : "assistant";
        if (hasOpenAI) {
          if (!openaiHistory) openaiHistory = [{ role: "system", content: SYSTEM_PROMPT }];
          openaiHistory.push({ role: oaRole, content: m.content });
        }
        if (hasClaude) {
          claudeHistory.push({ role: oaRole, content: m.content });
        }
      }
    }
    emit({ type: "history_loaded", count: msg.messages.length });
    return;
  }

  if (msg.type !== "message" || !msg.text) return;

  const userText = msg.text;
  
  // Track generation for this message (if provided by host)
  const messageGeneration = msg.generation ?? (currentGeneration + 1);
  currentGeneration = messageGeneration;
  processingGeneration = messageGeneration; // Set for emit functions to check

  // Reset interrupt state for new message
  interruptRequested = false;
  currentAbortController = new AbortController();
  const signal = currentAbortController.signal;

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

  // Provider cascade: try each currently available provider in priority order.
  // Re-evaluated per turn to detect providers added since session start.
  // If a provider fails, fall through to the next one instead of killing the turn.
  const cascade = [];
  if (hasClaude()) cascade.push({ name: "Claude", fn: runClaudeLoop });
  if (hasOpenAI()) cascade.push({ name: "OpenAI", fn: runOpenAILoop });
  if (hasGemini()) cascade.push({ name: "Gemini", fn: runGeminiLoop });

  if (cascade.length === 0) {
    emitError("Nenhum provedor de LLM disponível. Conecte Claude, OpenAI ou Gemini no painel de configurações.");
    currentAbortController = null;
    return;
  }

  let result;
  let lastErr;
  for (const provider of cascade) {
    try {
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
      process.stderr.write(`Provedor ${provider.name} falhou: ${err.message}\n`);
    }
  }

  currentAbortController = null;

  // Check if superseded before emitting response
  if (isSuperseded()) {
    return;
  }

  if (lastErr) {
    emitError(lastErr.message || "Erro desconhecido no sub-agente.");
  } else {
    // Signal that we're done processing this turn but ready for more input.
    // The session stays alive — the host will show the compose bar again.
    emitWaitingUser(result);
  }
});

rl.on("close", () => {
  process.exit(0);
});
