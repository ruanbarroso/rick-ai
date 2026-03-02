#!/usr/bin/env node
/**
 * agent.mjs — Unified sub-agent for AI assistant
 *
 * Entry point for the "subagent" container. Runs an agentic loop that:
 *  - Reads tasks from stdin as NDJSON  { type: "message", text, images? }
 *  - Executes tools (files, commands, web fetch, web browse)
 *  - Emits progress/results to stdout as NDJSON
 *
 * Provider priority: Gemini (always available via GEMINI_API_KEY) → OpenAI → Claude API
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
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  existsSync,
  mkdirSync,
} from "fs";
import { join, relative } from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// ── NDJSON helpers ──────────────────────────────────────────────────────────

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function emitMessage(text) {
  emit({ type: "message", text });
}

function emitStatus(message) {
  emit({ type: "status", message });
}

function emitDone(result) {
  emit({ type: "done", result });
}

function emitWaitingUser(result) {
  emit({ type: "waiting_user", result });
}

function emitError(message) {
  emit({ type: "error", message });
}

// ── Provider detection ──────────────────────────────────────────────────────

const hasGemini = !!process.env.GEMINI_API_KEY;
const hasOpenAI = !!(process.env.OPENAI_API_KEY || process.env.OPENAI_ACCESS_TOKEN);
const hasClaude = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_ACCESS_TOKEN);

const providers = [];
if (hasGemini) providers.push("gemini");
if (hasOpenAI) providers.push("openai");
if (hasClaude) providers.push("claude");

// ── Rick API client (for querying memories/credentials) ─────────────────────

const RICK_API_URL = process.env.RICK_API_URL || "";
const RICK_SESSION_TOKEN = process.env.RICK_SESSION_TOKEN || "";

async function rickApiGet(path) {
  if (!RICK_API_URL || !RICK_SESSION_TOKEN) {
    emitStatus("rick_memory/rick_search indisponivel: RICK_API_URL ou RICK_SESSION_TOKEN nao configurado");
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

// ── Tool implementations ────────────────────────────────────────────────────

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
          return `Erro: old_string nao encontrado em ${fp}`;
        }
        content = content.replace(input.old_string, input.new_string);
        writeFileSync(fp, content, "utf-8");
        return `Arquivo editado: ${fp}`;
      } catch (e) { return `Erro ao editar arquivo: ${e.message}`; }
    }
    case "list_directory": {
      const dp = resolvePath(input.path);
      const entries = listWorkspace(dp);
      return entries.length ? entries.join("\n") : "(diretorio vazio)";
    }
    case "run_command": {
      try {
        const { stdout, stderr } = await execFileAsync(
          input.command,
          input.args ?? [],
          { cwd: WORKSPACE, timeout: 120_000 }
        );
        return (stdout || "") + (stderr ? `\nSTDERR: ${stderr}` : "");
      } catch (e) {
        return `Saida ${e.code ?? 1}:\n${e.stdout ?? ""}\n${e.stderr ?? ""}`.trim();
      }
    }
    case "web_fetch": {
      try {
        const res = await fetch(input.url, { signal: AbortSignal.timeout(15000) });
        const text = await res.text();
        // Truncate large responses
        return text.length > 20000 ? text.substring(0, 20000) + "\n...(truncado)" : text;
      } catch (e) {
        return `Erro ao acessar ${input.url}: ${e.message}`;
      }
    }
    case "rick_memory": {
      const data = await rickApiGet(`/api/agent/memories${input.category ? `?category=${encodeURIComponent(input.category)}` : ""}`);
      if (!data) return "Nao foi possivel acessar as memorias do assistente.";
      return JSON.stringify(data.memories || [], null, 2);
    }
    case "rick_search": {
      const data = await rickApiGet(`/api/agent/search?q=${encodeURIComponent(input.query)}&limit=${input.limit || 5}`);
      if (!data) return "Busca semantica nao disponivel no assistente.";
      return JSON.stringify(data.results || [], null, 2);
    }
    default:
      return `Ferramenta desconhecida: ${name}`;
  }
}

// ── Agent name (used in tool descriptions and system prompt) ────────────────
const agentName = process.env.AGENT_NAME || "Rick";

// ── Tool declarations ───────────────────────────────────────────────────────

const toolDeclarations = [
  {
    name: "read_file",
    description: "Le o conteudo de um arquivo",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Caminho do arquivo" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Escreve conteudo em um arquivo (cria se nao existir)",
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
    description: "Substitui uma string exata em um arquivo (primeira ocorrencia)",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string", description: "String exata a ser substituida" },
        new_string: { type: "string", description: "String de substituicao" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "list_directory",
    description: "Lista arquivos de um diretorio recursivamente",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Diretorio (padrao: /workspace)" } },
    },
  },
  {
    name: "run_command",
    description: "Executa um comando shell (ex: git clone, npm install, curl)",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        args: { type: "array", items: { type: "string" } },
      },
      required: ["command"],
    },
  },
  {
    name: "web_fetch",
    description: "Faz uma requisicao HTTP GET e retorna o conteudo da pagina",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "URL para acessar" } },
      required: ["url"],
    },
  },
  {
    name: "rick_memory",
    description: `Lista memorias salvas pelo ${agentName} (credenciais, links, preferencias, informacoes do usuario). Sem categoria retorna TODAS as memorias. USE ESTA FERRAMENTA PRIMEIRO quando precisar de informacoes que o usuario ja tenha ensinado.`,
    parameters: {
      type: "object",
      properties: { category: { type: "string", description: "Categoria opcional para filtrar. Categorias comuns: credenciais, senhas, geral, pessoal, notas, preferencias. Omita para listar TODAS." } },
    },
  },
  {
    name: "rick_search",
    description: `Busca semantica nas conversas e memorias do ${agentName}. Use quando precisar encontrar algo especifico por significado (ex: 'repositorio zydon', 'email do cliente').`,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Texto para buscar por significado" },
        limit: { type: "number", description: "Numero maximo de resultados (padrao: 5)" },
      },
      required: ["query"],
    },
  },
];

const toolNames = toolDeclarations.map((t) => t.name);

// ── System prompt ───────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Voce e ${agentName} Sub-Agent, um agente autonomo executando dentro de um container Docker.

Sua tarefa e realizar o que o usuario pedir usando as ferramentas disponiveis.
Voce mantem o contexto de toda a conversa — mensagens anteriores do usuario sao lembradas.

REGRAS:
1. Responda sempre em portugues brasileiro.
2. Use as ferramentas para completar a tarefa. NAO invente resultados.
3. Quando terminar uma etapa, emita um resumo claro do que foi feito.
4. Se precisar de informacoes adicionais, PERGUNTE DIRETAMENTE ao usuario (ex: "Qual a URL do repositorio?") — voce recebera a resposta na proxima mensagem. Fale sempre em segunda pessoa, direto com o usuario.
5. Se precisar de informacoes que o usuario ja ensinou ao ${agentName} (credenciais, links de repositorios, preferencias), use rick_memory (sem categoria para ver TUDO) ou rick_search (busca por significado).
6. SEMPRE consulte rick_memory antes de pedir informacoes ao usuario — a resposta pode ja estar la.
7. Credenciais estao disponiveis como variaveis de ambiente RICK_SECRET_* e GITHUB_TOKEN no container. Use \`run_command env\` para listar TODAS as variaveis disponiveis.
8. Para clonar repositorios Git PRIVADOS, use o GITHUB_TOKEN: \`git clone https://\${GITHUB_TOKEN}@github.com/org/repo.git\`. SEMPRE tente com o token antes de dizer que nao tem acesso.
9. Para tarefas de codigo: clone o repositorio, faca as alteracoes, rode testes se possivel.
10. Para pesquisa web: use web_fetch para acessar URLs e extrair informacoes.
11. Seja conciso nas mensagens intermediarias, detalhado no resultado final.
12. Quando o usuario mencionar um projeto ou repositorio por nome, consulte rick_memory ou rick_search para descobrir a URL antes de perguntar.

FERRAMENTAS DISPONIVEIS: ${toolNames.join(", ")}`;

// ── Gemini adapter ──────────────────────────────────────────────────────────

async function callGemini(contents) {
  const apiKey = process.env.GEMINI_API_KEY;
  const MODEL = "gemini-2.5-flash";
  const BASE = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}`;
  const geminiTools = [{ functionDeclarations: toolDeclarations }];

  const res = await fetch(`${BASE}:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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

async function runGeminiLoop(userText) {
  const MAX_ITER = 25;
  geminiHistory.push({ role: "user", parts: [{ text: userText }] });
  let contents = geminiHistory;

  for (let iter = 0; iter < MAX_ITER; iter++) {
    const { texts, toolCalls, modelParts } = await callGemini(contents);
    contents.push({ role: "model", parts: modelParts });

    for (const text of texts) {
      if (toolCalls.length > 0 || iter < MAX_ITER - 1) {
        emitMessage(text);
      }
    }

    if (toolCalls.length === 0) {
      // No more tool calls — done
      return texts.join("\n") || "Tarefa concluida.";
    }

    // Execute tools
    const toolResults = [];
    for (const tc of toolCalls) {
      emitStatus(`Executando: ${tc.name}${tc.input.path ? ` (${tc.input.path})` : tc.input.url ? ` (${tc.input.url})` : tc.input.command ? ` (${tc.input.command})` : ""}`);
      const result = await executeTool(tc.name, tc.input);
      toolResults.push({ name: tc.name, result: String(result) });
    }

    contents.push({
      role: "user",
      parts: toolResults.map((r) => ({
        functionResponse: { name: r.name, response: { result: r.result } },
      })),
    });
  }

  return "Limite de iteracoes atingido.";
}

// ── OpenAI adapter ──────────────────────────────────────────────────────────

async function runOpenAILoop(userText) {
  const apiKey = process.env.OPENAI_API_KEY ?? "";
  const oauthToken = process.env.OPENAI_ACCESS_TOKEN ?? "";
  const authHeader = oauthToken ? `Bearer ${oauthToken}` : `Bearer ${apiKey}`;
  const openaiTools = toolDeclarations.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  const MAX_ITER = 25;
  if (!openaiHistory) {
    openaiHistory = [{ role: "system", content: SYSTEM_PROMPT }];
  }
  openaiHistory.push({ role: "user", content: userText });
  let messages = openaiHistory;

  for (let iter = 0; iter < MAX_ITER; iter++) {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
        ...(process.env.OPENAI_ACCOUNT_ID ? { "OpenAI-Organization": process.env.OPENAI_ACCOUNT_ID } : {}),
      },
      body: JSON.stringify({ model: "gpt-4o", messages, tools: openaiTools }),
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
      return msg.content || "Tarefa concluida.";
    }

    for (const tc of toolCalls) {
      emitStatus(`Executando: ${tc.name}`);
      const result = await executeTool(tc.name, tc.input);
      messages.push({ role: "tool", tool_call_id: tc.id, content: String(result) });
    }
  }

  return "Limite de iteracoes atingido.";
}

// ── Claude API adapter ──────────────────────────────────────────────────────

async function runClaudeLoop(userText) {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  const oauthToken = process.env.ANTHROPIC_ACCESS_TOKEN ?? "";
  const claudeTools = toolDeclarations.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));

  const MAX_ITER = 25;
  claudeHistory.push({ role: "user", content: userText });
  let messages = claudeHistory;

  for (let iter = 0; iter < MAX_ITER; iter++) {
    const headers = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    if (oauthToken) {
      headers["Authorization"] = `Bearer ${oauthToken}`;
    } else {
      headers["x-api-key"] = apiKey;
    }

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
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

    if (toolBlocks.length === 0 || data.stop_reason === "end_turn") {
      return textBlocks.map((b) => b.text).join("\n") || "Tarefa concluida.";
    }

    const toolResults = [];
    for (const tb of toolBlocks) {
      emitStatus(`Executando: ${tb.name}`);
      const result = await executeTool(tb.name, tb.input);
      toolResults.push({ type: "tool_result", tool_use_id: tb.id, content: String(result) });
    }

    messages.push({ role: "user", content: toolResults });
  }

  return "Limite de iteracoes atingido.";
}

// ── Main: stdin/stdout event loop ───────────────────────────────────────────

if (providers.length === 0) {
  emitError("Nenhum provedor de LLM disponivel. Configure GEMINI_API_KEY, OPENAI_API_KEY, ou ANTHROPIC_API_KEY.");
  process.exit(1);
}

// Emit ready signal
emit({ type: "ready", providers, tools: toolNames });

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

  try {
    let result;
    if (hasGemini) {
      result = await runGeminiLoop(userText);
    } else if (hasOpenAI) {
      result = await runOpenAILoop(userText);
    } else if (hasClaude) {
      result = await runClaudeLoop(userText);
    }

    // Signal that we're done processing this turn but ready for more input.
    // The session stays alive — the host will show the compose bar again.
    emitWaitingUser(result);
  } catch (err) {
    emitError(err.message || "Erro desconhecido no sub-agente.");
  }
});

rl.on("close", () => {
  process.exit(0);
});
