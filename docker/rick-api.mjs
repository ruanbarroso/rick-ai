/**
 * rick-api.mjs — Shared Rick API client, tool declarations, and tool handlers.
 *
 * Used by agent.mjs to avoid code duplication.
 * Provides:
 *   - rickApiGet() / rickApiPost() for querying the host API
 *   - Agent-specific tool declarations (rick_memory, rick_search, rick_save_memory, web_fetch)
 *   - Agent-specific tool handler function
 */

// ── Constants ───────────────────────────────────────────────────────────────

/** Timeout for Rick API HTTP calls (ms). */
export const RICK_API_TIMEOUT_MS = 5_000;

/** Timeout for web_fetch tool calls (ms). */
export const WEB_FETCH_TIMEOUT_MS = 15_000;

/** Timeout for LLM API calls (ms). 5 minutes — complex tool-use turns can be slow. */
export const LLM_TIMEOUT_MS = 300_000;

/** Maximum retries per provider on timeout before falling through to the next one. */
export const MAX_TIMEOUT_RETRIES = 1;

// ── Rick API client ─────────────────────────────────────────────────────────

/**
 * Get current auth/runtime values from process.env.
 * They are read per request because recovered sessions can receive update_token
 * messages that refresh token and API URL at runtime.
 */
function getRickSessionToken() {
  return process.env.RICK_SESSION_TOKEN || "";
}

function getRickApiUrl() {
  return process.env.RICK_API_URL || "";
}

/**
 * HTTP GET to the Rick host API.
 * @param {string} path - URL path (e.g. "/api/agent/memories")
 * @param {object} [opts]
 * @param {boolean} [opts.silent] - If true, suppress error status messages
 * @param {function} [opts.emitStatus] - Function to emit status messages (for non-silent errors)
 */
export async function rickApiGet(path, { silent = false, emitStatus } = {}) {
  const token = getRickSessionToken();
  const apiUrl = getRickApiUrl();
  if (!apiUrl || !token) {
    if (!silent && emitStatus) emitStatus("rick_memory/rick_search indisponivel: RICK_API_URL ou RICK_SESSION_TOKEN nao configurado");
    return null;
  }
  try {
    const res = await fetch(`${apiUrl}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(RICK_API_TIMEOUT_MS),
    });
    if (!res.ok) {
      if (!silent && emitStatus) emitStatus(`rick API erro: ${res.status} ${res.statusText}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    if (!silent && emitStatus) emitStatus(`rick API falhou: ${err.message || "timeout/rede"}`);
    return null;
  }
}

/**
 * HTTP POST to the Rick host API.
 * @param {string} path - URL path
 * @param {object} body - JSON body
 */
export async function rickApiPost(path, body) {
  const token = getRickSessionToken();
  const apiUrl = getRickApiUrl();
  if (!apiUrl || !token) {
    return { error: "RICK_API_URL ou RICK_SESSION_TOKEN nao configurado" };
  }
  try {
    const res = await fetch(`${apiUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(RICK_API_TIMEOUT_MS),
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

// ── Agent-specific tool declarations ────────────────────────────────────────

/**
 * Build agent-specific tool declarations (memory, search, web_fetch).
 * @param {string} agentName - Display name of the agent (e.g. "Rick")
 */
export function buildAgentToolDeclarations(agentName) {
  return [
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
    {
      name: "rick_save_memory",
      description: `Salva uma informacao na memoria persistente do ${agentName}. Use quando o usuario ensinar algo util (URLs de repositorios, preferencias, nomes de projetos, padroes, etc.) para que outros agentes futuros possam consultar. NAO use para credenciais/senhas — essas sao protegidas.`,
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "Identificador curto da memoria (ex: 'github_org_zydon', 'preferencia_linguagem')" },
          value: { type: "string", description: "Valor a salvar (ex: 'https://github.com/zydontecnologia', 'TypeScript com NestJS')" },
          category: { type: "string", description: "Categoria: geral, notas, preferencias, projetos, links. Padrao: geral. NAO use: credenciais, tokens, senhas." },
        },
        required: ["key", "value"],
      },
    },
  ];
}

// ── Agent-specific tool handler ─────────────────────────────────────────────

/**
 * Handle agent-specific tools (web_fetch, rick_memory, rick_search, rick_save_memory).
 * @param {string} name - Tool name
 * @param {object} input - Tool input parameters
 * @param {object} [opts]
 * @param {function} [opts.emitStatus] - Optional status emitter for non-silent API errors
 */
export async function agentToolHandler(name, input, { emitStatus } = {}) {
  switch (name) {
    case "web_fetch": {
      try {
        const res = await fetch(input.url, { signal: AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS) });
        const text = await res.text();
        return text.length > 20000 ? text.substring(0, 20000) + "\n...(truncado)" : text;
      } catch (e) {
        return `Erro ao acessar ${input.url}: ${e.message}`;
      }
    }
    case "rick_memory": {
      const data = await rickApiGet(`/api/agent/memories${input.category ? `?category=${encodeURIComponent(input.category)}` : ""}`, { emitStatus });
      if (!data) return "Nao foi possivel acessar as memorias do assistente.";
      return JSON.stringify(data.memories || [], null, 2);
    }
    case "rick_search": {
      const data = await rickApiGet(`/api/agent/search?q=${encodeURIComponent(input.query)}&limit=${input.limit || 5}`, { emitStatus });
      if (!data) return "Busca semantica nao disponivel no assistente.";
      return JSON.stringify(data.results || [], null, 2);
    }
    case "rick_save_memory": {
      const data = await rickApiPost("/api/agent/memory", {
        key: input.key,
        value: input.value,
        category: input.category || "geral",
      });
      if (data.error) return `Erro ao salvar memoria: ${data.error}`;
      return `Memoria salva: [${data.category}] ${data.key}`;
    }
    default:
      return undefined; // fall through to "unknown tool"
  }
}
