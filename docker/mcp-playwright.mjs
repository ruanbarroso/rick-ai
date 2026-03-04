import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const DEFAULT_COMMAND = ["npx", "-y", "@playwright/mcp@latest", "--browser", "chrome"];

let mcpClient = null;
let mcpTransport = null;
let mcpToolNames = [];

function parseCommand() {
  const raw = process.env.RICK_PLAYWRIGHT_MCP_COMMAND;
  if (!raw) return DEFAULT_COMMAND;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((x) => typeof x === "string")) {
      return parsed;
    }
  } catch {
    // ignore invalid JSON and use default
  }
  return DEFAULT_COMMAND;
}

async function ensureMcpClient() {
  if (mcpClient) return mcpClient;

  const [command, ...args] = parseCommand();
  if (!command) {
    throw new Error("RICK_PLAYWRIGHT_MCP_COMMAND invalido");
  }

  mcpTransport = new StdioClientTransport({
    command,
    args,
    cwd: "/workspace",
    env: { ...process.env },
    stderr: "pipe",
  });

  mcpClient = new Client({
    name: "rick-ai-subagent",
    version: "1.0.0",
  });

  await mcpClient.connect(mcpTransport);
  const listed = await mcpClient.listTools();
  mcpToolNames = Array.isArray(listed?.tools) ? listed.tools.map((t) => t.name) : [];
  return mcpClient;
}

function pickToolName(action) {
  const direct = [action, `browser_${action}`, `playwright_browser_${action}`];
  for (const name of direct) {
    if (mcpToolNames.includes(name)) return name;
  }

  const contains = mcpToolNames.find((name) => name.toLowerCase().includes(action.toLowerCase()));
  if (contains) return contains;
  return null;
}

function normalizeResult(result) {
  if (!result) return { ok: true };

  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }

  const textParts = Array.isArray(result.content)
    ? result.content
      .filter((c) => c && typeof c === "object" && c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
    : [];

  const joined = textParts.join("\n").trim();
  if (!joined) return { ok: true };

  try {
    return JSON.parse(joined);
  } catch {
    return { ok: true, text: joined };
  }
}

export async function callPlaywrightMcp(action, payload = {}) {
  const client = await ensureMcpClient();
  const toolName = pickToolName(action);
  if (!toolName) {
    throw new Error(`Playwright MCP nao tem ferramenta para acao: ${action}`);
  }
  const result = await client.callTool({
    name: toolName,
    arguments: payload || {},
  });
  return normalizeResult(result);
}

export async function closePlaywrightMcp() {
  const toClose = mcpClient;
  mcpClient = null;
  mcpTransport = null;
  mcpToolNames = [];
  if (!toClose) return;
  try {
    await toClose.close();
  } catch {
    // ignore close failure
  }
}
