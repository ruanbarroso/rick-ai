#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  {
    name: "rick-subagent-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

async function callRick(path, init = {}) {
  const token = process.env.RICK_SESSION_TOKEN || "";
  const apiUrl = process.env.RICK_API_URL || "";
  if (!token || !apiUrl) {
    throw new Error("RICK_API_URL ou RICK_SESSION_TOKEN nao configurado");
  }

  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(10_000),
  });

  const body = await response.text();
  let json = {};
  try {
    json = body ? JSON.parse(body) : {};
  } catch {
    json = { raw: body };
  }

  if (!response.ok) {
    const detail = json && typeof json === "object" && json.error ? json.error : `HTTP ${response.status}`;
    throw new Error(String(detail));
  }

  return json;
}

// Use the configured assistant name in tool descriptions so the LLM refers to
// the assistant by its custom name (e.g. "Zoe") instead of hardcoded "Rick".
const agentName = process.env.AGENT_NAME || "Rick";

const tools = [
  {
    name: "rick_memory",
    description: `Lista memorias da ${agentName}. Sem categoria retorna todas.`,
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", description: "Categoria opcional" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "rick_search",
    description: `Busca semantica nas memorias/conversas da ${agentName}.`,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Texto para busca semantica" },
        limit: { type: "number", description: "Limite de resultados" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "rick_save_memory",
    description: `Tenta salvar memoria na ${agentName} principal.`,
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Chave da memoria" },
        value: { type: "string", description: "Valor da memoria" },
        category: { type: "string", description: "Categoria da memoria" },
      },
      required: ["key", "value"],
      additionalProperties: false,
    },
  },
  {
    name: "rick_delete_memory",
    description: `Remove uma memoria incorreta, desatualizada ou lixo da ${agentName}. Use quando encontrar memorias com dados errados ou que nao fazem sentido.`,
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Chave da memoria a remover" },
        category: { type: "string", description: "Categoria da memoria (opcional, para filtrar)" },
      },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "rick_conversations",
    description: `Lista conversas recentes do usuario na ${agentName}.`,
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Limite de mensagens" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "rick_config",
    description: `Retorna configuracao operacional segura da ${agentName}.`,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const input = request.params.arguments || {};

  try {
    if (name === "rick_memory") {
      const category = typeof input.category === "string" && input.category.trim()
        ? `?category=${encodeURIComponent(input.category.trim())}`
        : "";
      const data = await callRick(`/api/agent/memories${category}`);
      return {
        content: [{ type: "text", text: JSON.stringify(data.memories || [], null, 2) }],
      };
    }

    if (name === "rick_search") {
      const query = String(input.query || "").trim();
      if (!query) throw new Error("Parametro 'query' e obrigatorio");
      const limit = Number.isFinite(input.limit) ? Math.max(1, Math.min(20, Number(input.limit))) : 5;
      const data = await callRick(`/api/agent/search?q=${encodeURIComponent(query)}&limit=${limit}`);
      return {
        content: [{ type: "text", text: JSON.stringify(data.results || [], null, 2) }],
      };
    }

    if (name === "rick_save_memory") {
      const key = String(input.key || "").trim();
      const value = String(input.value || "").trim();
      const category = String(input.category || "geral").trim();
      if (!key || !value) throw new Error("Campos 'key' e 'value' sao obrigatorios");
      const data = await callRick("/api/agent/memory", {
        method: "POST",
        body: JSON.stringify({ key, value, category }),
      });
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }

    if (name === "rick_delete_memory") {
      const key = String(input.key || "").trim();
      if (!key) throw new Error("Parametro 'key' e obrigatorio");
      const category = typeof input.category === "string" && input.category.trim()
        ? `&category=${encodeURIComponent(input.category.trim())}`
        : "";
      const data = await callRick(`/api/agent/memory?key=${encodeURIComponent(key)}${category}`, {
        method: "DELETE",
      });
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }

    if (name === "rick_conversations") {
      const limit = Number.isFinite(input.limit) ? Math.max(1, Math.min(100, Number(input.limit))) : 20;
      const data = await callRick(`/api/agent/conversations?limit=${limit}`);
      return {
        content: [{ type: "text", text: JSON.stringify(data.messages || [], null, 2) }],
      };
    }

    if (name === "rick_config") {
      const data = await callRick("/api/agent/config");
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }

    throw new Error(`Ferramenta desconhecida: ${name}`);
  } catch (error) {
    return {
      content: [{ type: "text", text: `Erro: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
