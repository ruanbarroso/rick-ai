/**
 * Unified sub-agent script.
 *
 * Runs inside a Docker container with Chromium + Playwright.
 * Communicates with Rick principal via stdin/stdout NDJSON.
 *
 * Tools: browser (Playwright), shell, files, HTTP, db_read (read-only PostgreSQL)
 * LLM cascade: Claude Opus 4.6 → GPT-5.4 Codex → Gemini 3.1 Pro → Gemini Flash
 * Context rotation: extracts summary when near window limit, continues in new window
 */

import { chromium } from "playwright";
import { createHmac } from "crypto";
import { execSync, spawn } from "child_process";
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { join, resolve, dirname } from "path";
import pg from "pg";
import { createInterface } from "readline";

// ==================== CONFIG ====================

const LLM_PROVIDERS = [];
const WORKSPACE = "/workspace";

// Ensure workspace exists
if (!existsSync(WORKSPACE)) mkdirSync(WORKSPACE, { recursive: true });

// Build LLM provider list from env vars (order = priority)
if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_ACCESS_TOKEN) {
  LLM_PROVIDERS.push({
    name: "claude-opus",
    model: "claude-opus-4-6",
    type: "anthropic",
    apiKey: process.env.ANTHROPIC_API_KEY,
    accessToken: process.env.ANTHROPIC_ACCESS_TOKEN,
    maxContextTokens: 200000,
    maxOutputTokens: 16384,
  });
}
if (process.env.OPENAI_API_KEY || process.env.OPENAI_ACCESS_TOKEN) {
  LLM_PROVIDERS.push({
    name: "gpt-codex",
    model: "gpt-5.3-codex",
    type: process.env.OPENAI_ACCESS_TOKEN ? "openai-codex" : "openai",
    apiKey: process.env.OPENAI_API_KEY,
    accessToken: process.env.OPENAI_ACCESS_TOKEN,
    accountId: process.env.OPENAI_ACCOUNT_ID || null,
    maxContextTokens: 200000,
    maxOutputTokens: 16384,
  });
}
if (process.env.GEMINI_API_KEY) {
  LLM_PROVIDERS.push({
    name: "gemini-pro",
    model: "gemini-3.1-pro-preview",
    type: "gemini",
    apiKey: process.env.GEMINI_API_KEY,
    maxContextTokens: 1000000,
    maxOutputTokens: 65536,
  });
  LLM_PROVIDERS.push({
    name: "gemini-flash",
    model: "gemini-3-flash-preview",
    type: "gemini",
    apiKey: process.env.GEMINI_API_KEY,
    maxContextTokens: 1000000,
    maxOutputTokens: 65536,
  });
}

if (LLM_PROVIDERS.length === 0) {
  emit("error", { message: "No LLM providers configured. Need at least one API key." });
  process.exit(1);
}

// DB connection (read-only)
let dbPool = null;
if (process.env.DATABASE_URL) {
  dbPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2, idleTimeoutMillis: 30000 });
}
let vectorPool = null;
if (process.env.PGVECTOR_URL) {
  vectorPool = new pg.Pool({ connectionString: process.env.PGVECTOR_URL, max: 2, idleTimeoutMillis: 30000 });
}

// ==================== NDJSON PROTOCOL ====================

function emit(type, data) {
  const msg = JSON.stringify({ type, ...data });
  process.stdout.write(msg + "\n");
}

// ==================== LLM CLIENTS ====================

async function callAnthropic(provider, messages, systemPrompt, tools) {
  const url = "https://api.anthropic.com/v1/messages";
  const headers = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (provider.accessToken) {
    headers["authorization"] = `Bearer ${provider.accessToken}`;
    headers["anthropic-beta"] = "oauth-2025-04-20";
  } else {
    headers["x-api-key"] = provider.apiKey;
  }

  const body = {
    model: provider.model,
    max_tokens: provider.maxOutputTokens,
    system: systemPrompt,
    messages,
  };
  if (tools && tools.length > 0) body.tools = tools;

  const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!resp.ok) {
    const errText = await resp.text();
    const err = new Error(`Anthropic ${resp.status}: ${errText.substring(0, 300)}`);
    err.status = resp.status;
    throw err;
  }
  const json = await resp.json();

  // Detect rate limit returned as 200 with limit message in text content
  const textBlocks = json.content?.filter(b => b.type === "text").map(b => b.text) || [];
  const fullText = textBlocks.join(" ").toLowerCase();
  if (
    (fullText.includes("hit your limit") || (fullText.includes("limit") && fullText.includes("resets"))) &&
    fullText.length < 200
  ) {
    const err = new Error(`Anthropic rate limit (in-body): ${textBlocks.join(" ").substring(0, 200)}`);
    err.status = 429;
    throw err;
  }

  return json;
}

async function callOpenAI(provider, messages, systemPrompt, tools) {
  const url = "https://api.openai.com/v1/chat/completions";
  const headers = { "content-type": "application/json" };
  if (provider.accessToken) {
    headers["authorization"] = `Bearer ${provider.accessToken}`;
  } else {
    headers["authorization"] = `Bearer ${provider.apiKey}`;
  }

  // Convert multimodal content blocks to OpenAI format
  const convertedMessages = messages.map(m => {
    if (m.role === "user" && Array.isArray(m.content)) {
      const parts = [];
      for (const block of m.content) {
        if (block.type === "text") {
          parts.push({ type: "text", text: block.text });
        } else if (block.type === "image" && block.source?.type === "base64") {
          parts.push({ type: "image_url", image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` } });
        }
      }
      return { role: m.role, content: parts.length > 0 ? parts : m.content };
    }
    return m;
  });
  const msgs = [{ role: "system", content: systemPrompt }, ...convertedMessages];
  const body = { model: provider.model, messages: msgs, max_tokens: provider.maxOutputTokens };
  if (tools && tools.length > 0) {
    body.tools = tools.map(t => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.input_schema }
    }));
  }

  const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!resp.ok) {
    const errText = await resp.text();
    const err = new Error(`OpenAI ${resp.status}: ${errText.substring(0, 300)}`);
    err.status = resp.status;
    throw err;
  }
  return await resp.json();
}

/**
 * OpenAI Codex Responses API (chatgpt.com) — used with OAuth tokens.
 * Different endpoint, different request/response format.
 * Requires stream:true and instructions field.
 */
async function callOpenAICodex(provider, messages, systemPrompt, tools) {
  const url = "https://chatgpt.com/backend-api/codex/responses";
  const headers = {
    "content-type": "application/json",
    "authorization": `Bearer ${provider.accessToken}`,
    "user-agent": "rick-ai/1.0",
    "originator": "opencode",
  };
  if (provider.accountId) {
    headers["chatgpt-account-id"] = provider.accountId;
  }

  // Build Responses API input format
  const input = [];
  for (const msg of messages) {
    if (msg.role === "system") continue;
    if (msg.role === "user") {
      const text = typeof msg.content === "string" ? msg.content : msg.content.map(b => b.text || "").join("");
      input.push({ role: "user", content: [{ type: "input_text", text }] });
    } else if (msg.role === "assistant") {
      const text = typeof msg.content === "string" ? msg.content : msg.content.filter(b => b.type === "text").map(b => b.text).join("");
      if (text) input.push({ role: "assistant", content: [{ type: "output_text", text }] });
    }
  }

  const body = {
    model: provider.model,
    instructions: systemPrompt || "You are a helpful assistant.",
    input,
    store: false,
    stream: true,
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120000);
  let resp;
  try {
    resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
  if (!resp.ok) {
    const errText = await resp.text();
    const err = new Error(`OpenAI Codex ${resp.status}: ${errText.substring(0, 300)}`);
    err.status = resp.status;
    throw err;
  }

  // Parse SSE stream to extract final response
  const sseText = await resp.text();
  const lines = sseText.split("\n");
  let lastResponse = null;
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      const data = line.substring(6).trim();
      if (data === "[DONE]") break;
      try {
        const event = JSON.parse(data);
        // Look for response.completed which has the final output
        if (event.type === "response.completed" && event.response) {
          lastResponse = event.response;
        }
        // Also capture response.created for partial data
        if (event.type === "response.created" && event.response) {
          lastResponse = event.response;
        }
      } catch (e) { /* skip malformed lines */ }
    }
  }

  if (!lastResponse) {
    throw new Error("OpenAI Codex: no response.completed event in stream");
  }
  return lastResponse;
}

async function callGemini(provider, messages, systemPrompt, tools) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${provider.model}:generateContent?key=${provider.apiKey}`;

  // Convert messages to Gemini format
  const contents = messages.map(m => {
    if (m.role === "assistant" || m.role === "model") {
      const parts = [];
      if (typeof m.content === "string") {
        parts.push({ text: m.content });
      } else if (Array.isArray(m.content)) {
        for (const block of m.content) {
          if (block.type === "text") parts.push({ text: block.text });
          if (block.type === "tool_use") {
            parts.push({ functionCall: { name: block.name, args: block.input } });
          }
        }
      }
      return { role: "model", parts };
    }
    if (m.role === "tool") {
      return {
        role: "user",
        parts: [{ functionResponse: { name: m.tool_name || "tool", response: { content: m.content } } }],
      };
    }
    // user — handle multimodal content (text + images)
    if (typeof m.content === "string") {
      return { role: "user", parts: [{ text: m.content }] };
    }
    if (Array.isArray(m.content)) {
      const parts = [];
      for (const block of m.content) {
        if (block.type === "text") {
          parts.push({ text: block.text });
        } else if (block.type === "image" && block.source?.type === "base64") {
          parts.push({ inlineData: { mimeType: block.source.media_type, data: block.source.data } });
        }
      }
      if (parts.length > 0) return { role: "user", parts };
    }
    return { role: "user", parts: [{ text: JSON.stringify(m.content) }] };
  });

  const body = {
    contents,
    generationConfig: { temperature: 0.3, maxOutputTokens: provider.maxOutputTokens },
  };
  if (systemPrompt) body.systemInstruction = { parts: [{ text: systemPrompt }] };
  if (tools && tools.length > 0) {
    body.tools = [{
      functionDeclarations: tools.map(t => ({
        name: t.name,
        description: t.description,
        parameters: convertJsonSchemaToGemini(t.input_schema),
      }))
    }];
  }

  const resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!resp.ok) {
    const errText = await resp.text();
    const err = new Error(`Gemini ${resp.status}: ${errText.substring(0, 300)}`);
    err.status = resp.status;
    throw err;
  }
  return await resp.json();
}

function convertJsonSchemaToGemini(schema) {
  if (!schema) return { type: "OBJECT", properties: {} };
  const result = {};
  if (schema.type) result.type = schema.type.toUpperCase();
  if (schema.properties) {
    result.properties = {};
    for (const [k, v] of Object.entries(schema.properties)) {
      result.properties[k] = { type: (v.type || "string").toUpperCase(), description: v.description || "" };
    }
  }
  if (schema.required) result.required = schema.required;
  return result;
}

// ==================== UNIFIED LLM CALL WITH CASCADE ====================

// Track which providers are temporarily disabled (rate limited)
const disabledProviders = new Map(); // name -> timestamp when to re-enable

async function llmCall(messages, systemPrompt, tools) {
  const now = Date.now();

  for (const provider of LLM_PROVIDERS) {
    // Skip temporarily disabled providers
    const disabledUntil = disabledProviders.get(provider.name);
    if (disabledUntil && now < disabledUntil) continue;
    if (disabledUntil && now >= disabledUntil) disabledProviders.delete(provider.name);

    try {
      emit("status", { message: `Usando ${provider.name}...` });
      let result;

      if (provider.type === "anthropic") {
        result = await callAnthropic(provider, messages, systemPrompt, tools);
        return normalizeAnthropicResponse(result, provider);
      }
      if (provider.type === "openai") {
        result = await callOpenAI(provider, messages, systemPrompt, tools);
        return normalizeOpenAIResponse(result, provider);
      }
      if (provider.type === "openai-codex") {
        result = await callOpenAICodex(provider, messages, systemPrompt, tools);
        return normalizeCodexResponse(result, provider);
      }
      if (provider.type === "gemini") {
        result = await callGemini(provider, messages, systemPrompt, tools);
        return normalizeGeminiResponse(result, provider);
      }
    } catch (err) {
      const isRateLimit = err.status === 429 || err.status === 529 || /rate.?limit|quota|overloaded|capacity|hit your limit|limit.*resets/i.test(err.message);
      if (isRateLimit) {
        emit("status", { message: `${provider.name} rate limited, tentando proximo...` });
        // Disable for 60s
        disabledProviders.set(provider.name, now + 60000);
        continue;
      }
      const isAuthError = err.status === 401 || err.status === 403;
      if (isAuthError) {
        emit("status", { message: `${provider.name} erro de auth, tentando proximo...` });
        // Disable permanently for this session
        disabledProviders.set(provider.name, now + 999999999);
        continue;
      }
      // Other error — try next
      emit("status", { message: `${provider.name} erro: ${err.message.substring(0, 100)}, tentando proximo...` });
      continue;
    }
  }

  throw new Error("Todos os provedores LLM falharam. Nenhum modelo disponivel.");
}

// ==================== RESPONSE NORMALIZERS ====================
// All return: { text: string|null, toolCalls: [{id, name, input}], model: string, tokensUsed: number }

function normalizeAnthropicResponse(resp, provider) {
  const text = resp.content?.filter(b => b.type === "text").map(b => b.text).join("") || null;
  const toolCalls = resp.content?.filter(b => b.type === "tool_use").map(b => ({
    id: b.id, name: b.name, input: b.input
  })) || [];
  return {
    text: text || null,
    toolCalls,
    model: provider.name,
    tokensUsed: (resp.usage?.input_tokens || 0) + (resp.usage?.output_tokens || 0),
    stopReason: resp.stop_reason,
    raw: resp,
  };
}

function normalizeOpenAIResponse(resp, provider) {
  const choice = resp.choices?.[0];
  const text = choice?.message?.content || null;
  const toolCalls = (choice?.message?.tool_calls || []).map(tc => ({
    id: tc.id, name: tc.function.name, input: JSON.parse(tc.function.arguments || "{}")
  }));
  return {
    text,
    toolCalls,
    model: provider.name,
    tokensUsed: resp.usage?.total_tokens || 0,
    stopReason: choice?.finish_reason,
    raw: resp,
  };
}

function normalizeCodexResponse(resp, provider) {
  // Codex Responses API output format
  let text = "";
  if (resp.output && Array.isArray(resp.output)) {
    for (const item of resp.output) {
      if (item.type === "message" && item.content) {
        for (const part of item.content) {
          if (part.type === "output_text") text += part.text;
        }
      }
    }
  }
  return {
    text: text || null,
    toolCalls: [], // Codex Responses API doesn't support tool_use in this simple integration
    model: provider.name,
    tokensUsed: (resp.usage?.input_tokens || 0) + (resp.usage?.output_tokens || 0),
    stopReason: resp.status || "completed",
    raw: resp,
  };
}

function normalizeGeminiResponse(resp, provider) {
  const candidate = resp.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const textParts = parts.filter(p => p.text).map(p => p.text);
  const text = textParts.length > 0 ? textParts.join("") : null;
  const toolCalls = parts.filter(p => p.functionCall).map((p, i) => ({
    id: `gemini_tc_${i}`, name: p.functionCall.name, input: p.functionCall.args || {}
  }));
  return {
    text,
    toolCalls,
    model: provider.name,
    tokensUsed: resp.usageMetadata?.totalTokenCount || 0,
    stopReason: candidate?.finishReason,
    raw: resp,
  };
}

// ==================== TOOLS DEFINITION (Anthropic format, normalized for all) ====================

const TOOLS = [
  {
    name: "browser_navigate",
    description: "Navigate browser to a URL",
    input_schema: {
      type: "object",
      properties: { url: { type: "string", description: "URL to navigate to" } },
      required: ["url"],
    },
  },
  {
    name: "browser_snapshot",
    description: "Get the current page accessibility tree (YAML). Use this to see what's on the page.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "browser_click",
    description: "Click an element by its role and accessible name from the snapshot.",
    input_schema: {
      type: "object",
      properties: {
        role: { type: "string", description: "ARIA role: button, link, textbox, menuitem, etc." },
        name: { type: "string", description: "Accessible name from snapshot" },
      },
      required: ["role", "name"],
    },
  },
  {
    name: "browser_fill",
    description: "Type text into an input field by role and accessible name.",
    input_schema: {
      type: "object",
      properties: {
        role: { type: "string", description: "ARIA role (usually 'textbox')" },
        name: { type: "string", description: "Accessible name" },
        value: { type: "string", description: "Text to type" },
      },
      required: ["role", "value"],
    },
  },
  {
    name: "browser_press_key",
    description: "Press a keyboard key (Enter, Tab, Escape, etc.)",
    input_schema: {
      type: "object",
      properties: { key: { type: "string", description: "Key name" } },
      required: ["key"],
    },
  },
  {
    name: "browser_screenshot",
    description: "Take a screenshot of the current page. Returns base64 image.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "browser_wait",
    description: "Wait for a specified number of seconds (1-30)",
    input_schema: {
      type: "object",
      properties: { seconds: { type: "number", description: "Seconds to wait" } },
      required: ["seconds"],
    },
  },
  {
    name: "shell_exec",
    description: "Execute a shell command and return stdout/stderr. Use for installing packages, running scripts, git, etc.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        cwd: { type: "string", description: "Working directory (default: /workspace)" },
        timeout: { type: "number", description: "Timeout in seconds (default: 60)" },
      },
      required: ["command"],
    },
  },
  {
    name: "file_read",
    description: "Read a file from the filesystem. Path is relative to /workspace or absolute.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        offset: { type: "number", description: "Start line (1-indexed, default: 1)" },
        limit: { type: "number", description: "Max lines to read (default: 500)" },
      },
      required: ["path"],
    },
  },
  {
    name: "file_write",
    description: "Write content to a file. Creates parent directories if needed.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        content: { type: "string", description: "File content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "file_list",
    description: "List files and directories in a path.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "Directory path (default: /workspace)" } },
    },
  },
  {
    name: "http_fetch",
    description: "Make an HTTP request and return the response body (text).",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch" },
        method: { type: "string", description: "HTTP method (default: GET)" },
        headers: { type: "string", description: "JSON string of headers" },
        body: { type: "string", description: "Request body" },
      },
      required: ["url"],
    },
  },
  {
    name: "db_query",
    description: "Execute a READ-ONLY SQL query on Rick's PostgreSQL database. Only SELECT statements allowed.",
    input_schema: {
      type: "object",
      properties: { sql: { type: "string", description: "SELECT query" } },
      required: ["sql"],
    },
  },
  {
    name: "vector_search",
    description: "Semantic search on Rick's vector memory (PGVector). Returns similar memories.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query text" },
        limit: { type: "number", description: "Max results (default: 10)" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_totp_code",
    description: "Generate a TOTP 6-digit code from a base32 secret key (for 2FA).",
    input_schema: {
      type: "object",
      properties: { secret: { type: "string", description: "Base32 TOTP secret" } },
      required: ["secret"],
    },
  },
  {
    name: "done",
    description: "Signal that the task is complete. Return a final message to the user.",
    input_schema: {
      type: "object",
      properties: { result: { type: "string", description: "Final result message in pt-BR" } },
      required: ["result"],
    },
  },
];

// ==================== TOOL EXECUTION ====================

let browserContext = null;
let browser = null;

async function ensureBrowser() {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    browserContext = await browser.newContext({
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 720 },
      locale: "pt-BR",
    });
    browserContext.on("page", (p) => emit("status", { message: `Nova aba: ${p.url()}` }));
  }
  return browserContext;
}

function getActivePage(ctx) {
  const pages = ctx.pages();
  return pages[pages.length - 1] || null;
}

function generateTOTP(secret) {
  try {
    const base32chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = "";
    for (const c of secret.toUpperCase().replace(/\s+/g, "")) {
      const val = base32chars.indexOf(c);
      if (val === -1) continue;
      bits += val.toString(2).padStart(5, "0");
    }
    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.substring(i, i + 8), 2));
    const keyBuffer = Buffer.from(bytes);
    const time = Math.floor(Date.now() / 1000 / 30);
    const timeBuffer = Buffer.alloc(8);
    timeBuffer.writeUInt32BE(Math.floor(time / 0x100000000), 0);
    timeBuffer.writeUInt32BE(time & 0xffffffff, 4);
    const hmac = createHmac("sha1", keyBuffer);
    hmac.update(timeBuffer);
    const hash = hmac.digest();
    const offset = hash[hash.length - 1] & 0xf;
    const code = ((hash[offset] & 0x7f) << 24) | ((hash[offset + 1] & 0xff) << 16) | ((hash[offset + 2] & 0xff) << 8) | (hash[offset + 3] & 0xff);
    return (code % 1000000).toString().padStart(6, "0");
  } catch { return null; }
}

async function executeTool(name, args) {
  try {
    switch (name) {
      case "browser_navigate": {
        const ctx = await ensureBrowser();
        let page = getActivePage(ctx);
        if (!page) page = await ctx.newPage();
        await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(1000);
        return `Navigated to ${args.url}. Current URL: ${page.url()}`;
      }
      case "browser_snapshot": {
        const ctx = await ensureBrowser();
        const page = getActivePage(ctx);
        if (!page) return "No active page. Use browser_navigate first.";
        const snap = await page.locator("body").ariaSnapshot({ timeout: 8000 }).catch(() => null);
        if (snap) return snap.length > 12000 ? snap.substring(0, 12000) + "\n... (truncated)" : snap;
        const text = await page.evaluate(() => document.body.innerText?.substring(0, 6000) || "").catch(() => "");
        return `[Snapshot fallback - text]: ${text}`;
      }
      case "browser_click": {
        const ctx = await ensureBrowser();
        const page = getActivePage(ctx);
        if (!page) return "No active page.";
        const loc = args.name ? page.getByRole(args.role, { name: args.name }) : page.getByRole(args.role).first();
        await loc.click({ timeout: 10000 });
        await page.waitForTimeout(2000);
        const ap = getActivePage(ctx);
        return `Clicked ${args.role} "${args.name || ""}". URL: ${ap?.url() || "(closed)"}`;
      }
      case "browser_fill": {
        const ctx = await ensureBrowser();
        const page = getActivePage(ctx);
        if (!page) return "No active page.";
        const loc = args.name ? page.getByRole(args.role, { name: args.name }) : page.getByRole(args.role).first();
        await loc.fill(args.value, { timeout: 10000 });
        return `Filled ${args.role} "${args.name || ""}" with text.`;
      }
      case "browser_press_key": {
        const ctx = await ensureBrowser();
        const page = getActivePage(ctx);
        if (!page) return "No active page.";
        await page.keyboard.press(args.key);
        await page.waitForTimeout(500);
        return `Pressed ${args.key}`;
      }
      case "browser_screenshot": {
        const ctx = await ensureBrowser();
        const page = getActivePage(ctx);
        if (!page) return "No active page.";
        const buf = await page.screenshot({ type: "jpeg", quality: 60 });
        return `[Screenshot: ${buf.length} bytes, base64]\n${buf.toString("base64").substring(0, 200)}... (use browser_snapshot for structured data)`;
      }
      case "browser_wait": {
        const ctx = await ensureBrowser();
        const page = getActivePage(ctx);
        const ms = Math.min(Math.max((args.seconds || 1) * 1000, 500), 30000);
        if (page) await page.waitForTimeout(ms);
        else await new Promise(r => setTimeout(r, ms));
        return `Waited ${ms / 1000}s`;
      }
      case "shell_exec": {
        const cwd = args.cwd || WORKSPACE;
        const timeout = (args.timeout || 60) * 1000;
        try {
          const out = execSync(args.command, { cwd, timeout, maxBuffer: 1024 * 1024, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
          return out.length > 20000 ? out.substring(0, 20000) + "\n... (truncated)" : (out || "(no output)");
        } catch (err) {
          const stderr = err.stderr?.toString() || "";
          const stdout = err.stdout?.toString() || "";
          return `Exit code ${err.status || 1}\nSTDOUT: ${stdout.substring(0, 5000)}\nSTDERR: ${stderr.substring(0, 5000)}`;
        }
      }
      case "file_read": {
        const p = args.path.startsWith("/") ? args.path : join(WORKSPACE, args.path);
        if (!existsSync(p)) return `File not found: ${p}`;
        const content = readFileSync(p, "utf-8");
        const lines = content.split("\n");
        const offset = Math.max(0, (args.offset || 1) - 1);
        const limit = args.limit || 500;
        const slice = lines.slice(offset, offset + limit);
        const result = slice.map((l, i) => `${offset + i + 1}: ${l}`).join("\n");
        return result.length > 30000 ? result.substring(0, 30000) + "\n... (truncated)" : result;
      }
      case "file_write": {
        const p = args.path.startsWith("/") ? args.path : join(WORKSPACE, args.path);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, args.content, "utf-8");
        return `File written: ${p} (${args.content.length} chars)`;
      }
      case "file_list": {
        const p = args.path || WORKSPACE;
        const dir = p.startsWith("/") ? p : join(WORKSPACE, p);
        if (!existsSync(dir)) return `Directory not found: ${dir}`;
        const entries = readdirSync(dir);
        const result = entries.map(e => {
          try {
            const s = statSync(join(dir, e));
            return `${s.isDirectory() ? "d" : "-"} ${e}${s.isDirectory() ? "/" : ""} (${s.size}b)`;
          } catch { return `? ${e}`; }
        }).join("\n");
        return result || "(empty directory)";
      }
      case "http_fetch": {
        const method = (args.method || "GET").toUpperCase();
        const headers = args.headers ? JSON.parse(args.headers) : {};
        const opts = { method, headers };
        if (args.body && method !== "GET") opts.body = args.body;
        const resp = await fetch(args.url, opts);
        const body = await resp.text();
        const truncated = body.length > 20000 ? body.substring(0, 20000) + "\n... (truncated)" : body;
        return `HTTP ${resp.status} ${resp.statusText}\n${truncated}`;
      }
      case "db_query": {
        if (!dbPool) return "Database not configured (no DATABASE_URL)";
        const sql = args.sql.trim();
        if (!/^\s*SELECT\b/i.test(sql)) return "Only SELECT queries allowed (read-only)";
        const result = await dbPool.query(sql);
        return JSON.stringify(result.rows, null, 2).substring(0, 20000);
      }
      case "vector_search": {
        if (!vectorPool) return "Vector DB not configured (no PGVECTOR_URL)";
        // Use pg to generate embedding via a simple query approach
        // For now, do a text-based search on the content column
        const limit = args.limit || 10;
        const result = await vectorPool.query(
          `SELECT content, category, metadata, created_at FROM memories WHERE content ILIKE $1 ORDER BY created_at DESC LIMIT $2`,
          [`%${args.query}%`, limit]
        );
        return JSON.stringify(result.rows, null, 2).substring(0, 20000);
      }
      case "get_totp_code": {
        const code = generateTOTP(args.secret);
        return code ? `TOTP code: ${code}` : "Failed to generate TOTP — check the secret key";
      }
      case "done":
        return null; // Signal to end

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Error in ${name}: ${err.message}`;
  }
}

// ==================== CONTEXT ROTATION ====================

let totalTokensUsed = 0;
let conversationHistory = []; // { role, content } array

function estimateTokens(text) {
  // Rough estimate: ~4 chars per token
  return Math.ceil((typeof text === "string" ? text.length : JSON.stringify(text).length) / 4);
}

function getCurrentProvider() {
  const now = Date.now();
  for (const p of LLM_PROVIDERS) {
    const disabledUntil = disabledProviders.get(p.name);
    if (disabledUntil && now < disabledUntil) continue;
    return p;
  }
  return LLM_PROVIDERS[0]; // fallback
}

async function rotateContextIfNeeded() {
  const provider = getCurrentProvider();
  const contextLimit = provider.maxContextTokens;
  const historyTokens = estimateTokens(JSON.stringify(conversationHistory));

  if (historyTokens < contextLimit * 0.75) return; // Not near limit

  emit("status", { message: "Contexto perto do limite, extraindo resumo..." });

  // Build a summary request
  const summaryMessages = [
    ...conversationHistory,
    {
      role: "user",
      content: `INSTRUCAO DE SISTEMA: O contexto da conversa esta proximo do limite. 
Faca um RESUMO DETALHADO de tudo que foi discutido e realizado ate agora.
Inclua: tarefas completadas, decisoes tomadas, arquivos modificados, estado atual do trabalho, proximos passos pendentes.
Este resumo sera usado como contexto para continuar a conversa em uma nova janela.
Seja completo e preciso — toda informacao importante deve estar no resumo.`
    }
  ];

  try {
    const result = await llmCall(summaryMessages, SYSTEM_PROMPT, []);
    const summary = result.text || "Resumo indisponivel.";

    // Reset conversation with summary as context
    conversationHistory = [
      {
        role: "user",
        content: `CONTEXTO DE SESSAO ANTERIOR (resumo automatico por context rotation):\n\n${summary}\n\nContinue o trabalho a partir deste ponto. O usuario pode enviar novas instrucoes ou voce pode continuar tarefas pendentes.`
      },
      {
        role: "assistant",
        content: "Entendido. Tenho o contexto completo da sessao anterior. Pronto para continuar."
      }
    ];
    totalTokensUsed = estimateTokens(JSON.stringify(conversationHistory));
    emit("status", { message: "Contexto rotacionado. Continuando..." });
  } catch (err) {
    emit("status", { message: `Erro ao rotacionar contexto: ${err.message}` });
  }
}

// ==================== SYSTEM PROMPT ====================

const SYSTEM_PROMPT = `Voce e um sub-agente autonomo do Rick AI, um assistente pessoal.
Voce tem acesso a ferramentas poderosas: browser (Playwright), shell, arquivos, HTTP e banco de dados (somente leitura).

REGRAS:
1. Seja eficiente e direto. Use as ferramentas minimas necessarias para completar a tarefa.
2. Responda sempre em portugues brasileiro.
3. Formate respostas para WhatsApp: *negrito*, _italico_, listas com - ou numeros.
4. Use browser_snapshot (nao screenshot) para navegar — o snapshot da a arvore de acessibilidade em YAML.
5. Para credenciais/senhas, o Rick principal vai fornecer no contexto. Nunca invente credenciais.
6. Se algo der errado, explique o problema claramente e sugira alternativas.
7. Quando terminar a tarefa, use a ferramenta 'done' com um resumo do resultado.
8. Para tarefas longas, va reportando progresso via texto (sem done) para o usuario acompanhar.
9. O banco de dados e SOMENTE LEITURA. Voce pode consultar mas NAO pode inserir/atualizar/deletar.
10. Se o usuario mandar uma mensagem de follow-up, continue trabalhando na mesma tarefa.
11. Se receber CONTEXTO DE SESSAO ANTERIOR, use-o para entender o que ja foi feito.
12. NAO invente informacoes — retorne apenas o que realmente verificou/executou.`;

// ==================== MAIN AGENTIC LOOP ====================

/**
 * Build a multimodal user content block from text + image paths.
 * For Anthropic: array of { type: "text" } and { type: "image", source: { type: "base64", ... } }
 * For others: we embed a note about images (they don't support vision in this format).
 */
function buildUserContent(text, imagePaths) {
  if (!imagePaths || imagePaths.length === 0) return text;

  // Read images and build multimodal content blocks
  const blocks = [];
  for (const imgPath of imagePaths) {
    try {
      const data = readFileSync(imgPath);
      const base64 = data.toString("base64");
      const ext = imgPath.split(".").pop() || "png";
      const mimeMap = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" };
      const mediaType = mimeMap[ext] || "image/png";
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: mediaType, data: base64 },
      });
    } catch (err) {
      // Skip unreadable images
    }
  }

  if (blocks.length === 0) return text;
  blocks.push({ type: "text", text: text || "Analise esta(s) imagem(ns)." });
  return blocks;
}

async function handleUserMessage(text, imagePaths) {
  // Add user message to history (multimodal if images present)
  const userContent = buildUserContent(text, imagePaths);
  conversationHistory.push({ role: "user", content: userContent });

  // Check if context rotation is needed
  await rotateContextIfNeeded();

  const MAX_STEPS = 100;
  for (let step = 0; step < MAX_STEPS; step++) {
    let response;
    try {
      response = await llmCall(conversationHistory, SYSTEM_PROMPT, TOOLS);
    } catch (err) {
      emit("message", { role: "assistant", text: `Erro: ${err.message}` });
      return;
    }

    totalTokensUsed += response.tokensUsed;

    // If the LLM returned text, send it as a progress message
    if (response.text) {
      emit("message", { role: "assistant", text: response.text });
    }

    // If no tool calls, we're done with this turn
    if (response.toolCalls.length === 0) {
      // Add assistant response to history
      if (response.text) {
        conversationHistory.push({ role: "assistant", content: response.text });
      }
      return;
    }

    // Add assistant response (with tool calls) to history
    if (response.model.startsWith("claude") || response.model.startsWith("gpt")) {
      // Anthropic/OpenAI format: content blocks
      const contentBlocks = [];
      if (response.text) contentBlocks.push({ type: "text", text: response.text });
      for (const tc of response.toolCalls) {
        contentBlocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
      }
      conversationHistory.push({ role: "assistant", content: contentBlocks });
    } else {
      // Gemini format: store as assistant text + function calls
      conversationHistory.push({ role: "assistant", content: response.text || "" });
    }

    // Execute tool calls
    for (const tc of response.toolCalls) {
      emit("status", { message: `Executando ${tc.name}...` });

      const result = await executeTool(tc.name, tc.input);

      // done() signals task complete
      if (result === null) {
        const doneText = tc.input.result || "(tarefa concluida)";
        emit("done", { result: doneText });
        conversationHistory.push({ role: "assistant", content: doneText });
        return;
      }

      // Add tool result to history
      if (response.model.startsWith("claude")) {
        conversationHistory.push({ role: "user", content: [{ type: "tool_result", tool_use_id: tc.id, content: result }] });
      } else if (response.model.startsWith("gpt")) {
        conversationHistory.push({ role: "tool", tool_call_id: tc.id, tool_name: tc.name, content: result });
      } else {
        // Gemini
        conversationHistory.push({ role: "tool", tool_name: tc.name, content: result });
      }
    }

    // Check context rotation after tool execution
    await rotateContextIfNeeded();
  }

  emit("message", { role: "assistant", text: "Atingi o limite de passos. Tente novamente com instrucoes mais especificas." });
}

// ==================== STDIN LISTENER ====================

const rl = createInterface({ input: process.stdin });

emit("ready", { tools: TOOLS.map(t => t.name), providers: LLM_PROVIDERS.map(p => p.name) });

rl.on("line", async (line) => {
  try {
    const msg = JSON.parse(line.trim());

    if (msg.type === "message") {
      await handleUserMessage(msg.text, msg.images);
    } else if (msg.type === "ping") {
      emit("pong", {});
    } else if (msg.type === "kill") {
      if (browser) await browser.close().catch(() => {});
      if (dbPool) await dbPool.end().catch(() => {});
      if (vectorPool) await vectorPool.end().catch(() => {});
      process.exit(0);
    }
  } catch (err) {
    emit("error", { message: `Parse error: ${err.message}` });
  }
});

rl.on("close", async () => {
  if (browser) await browser.close().catch(() => {});
  if (dbPool) await dbPool.end().catch(() => {});
  if (vectorPool) await vectorPool.end().catch(() => {});
  process.exit(0);
});

process.on("SIGTERM", async () => {
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
});
