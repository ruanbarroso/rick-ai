/**
 * tools.mjs — Shared tool implementations for sub-agent containers
 *
 * Single source of truth for workspace helpers and tool execution.
 * Imported by agent.mjs.
 */

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  mkdirSync,
} from "fs";
import { join, relative } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { callPlaywrightMcp, closePlaywrightMcp } from "./mcp-playwright.mjs";

const execFileAsync = promisify(execFile);

// ── Secret redaction ────────────────────────────────────────────────────────
// Collect env vars that look like secrets and build a redaction function.
// Applied to all tool output before it reaches the LLM or the session viewer,
// preventing the LLM from ever seeing raw credentials (so it can't parrot them).

const SECRET_ENV_PREFIXES = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_ACCESS_TOKEN",
  "OPENAI_API_KEY", "OPENAI_ACCESS_TOKEN",
  "GEMINI_API_KEY",
  "GITHUB_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_API_KEY", "CLAUDE_REFRESH_TOKEN",
  "RICK_SESSION_TOKEN",
];

/** Env var names whose values must never appear in tool output. */
const SECRET_PATTERNS = [];
for (const key of Object.keys(process.env)) {
  // Match known prefixes or any var containing SECRET/TOKEN/PASSWORD/KEY
  const isSecret = SECRET_ENV_PREFIXES.includes(key)
    || /SECRET|TOKEN|PASSWORD|CREDENTIAL|PRIVATE.KEY/i.test(key);
  const val = process.env[key];
  if (isSecret && val && val.length >= 8) {
    SECRET_PATTERNS.push({ key, val });
  }
}

/**
 * Register runtime secret values discovered during execution (e.g. passwords
 * retrieved from rick_memory).  Values shorter than 6 chars are ignored to
 * avoid false-positive redaction of common words.
 */
export function registerRuntimeSecrets(values) {
  if (!Array.isArray(values)) return;
  for (const v of values) {
    if (typeof v !== "string" || v.length < 6) continue;
    // Avoid duplicates
    if (SECRET_PATTERNS.some((p) => p.val === v)) continue;
    SECRET_PATTERNS.push({ key: "memory", val: v });
  }
}

/**
 * Redact known secret values from a string.
 * Replaces each secret occurrence with [REDACTED:<ENV_VAR_NAME>].
 */
export function redactSecrets(text) {
  if (!text || SECRET_PATTERNS.length === 0) return text;
  let result = text;
  for (const { key, val } of SECRET_PATTERNS) {
    // Use split+join instead of regex to avoid special chars in secret values
    if (result.includes(val)) {
      result = result.split(val).join(`[REDACTED:${key}]`);
    }
  }
  return result;
}

// ── Workspace helpers ───────────────────────────────────────────────────────

export const WORKSPACE = "/workspace";

export function resolvePath(p) {
  if (!p) return WORKSPACE;
  return p.startsWith("/") ? p : join(WORKSPACE, p);
}

export function listWorkspace(dir, depth = 0) {
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

// ── Tool status label (DRY helper for emitStatus) ───────────────────────────

export function toolStatusLabel(name, input) {
  const ctx = input.path ? ` (${input.path})`
    : input.url ? ` (${input.url})`
    : input.command ? ` (${input.command})`
    : "";
  return `Executando: ${name}${ctx}`;
}

// ── Core tool execution (shared by both agents) ─────────────────────────────

const COMMAND_TIMEOUT = 120_000; // 2 minutes

function isPlaywrightRefValidationError(err) {
  const text = String(err?.message || err || "").toLowerCase();
  return text.includes("invalid input")
    || text.includes("invalid_type")
    || text.includes("\"path\":[\"ref\"]")
    || (text.includes("expected string") && text.includes("ref"));
}

/**
 * Detect when the model passes a Playwright snapshot ref as a CSS selector.
 * e.g. "button[ref='e51']" or just "e51" — these are NOT valid CSS selectors,
 * they are internal Playwright snapshot identifiers.
 */
function extractSnapshotRef(selector) {
  if (!selector || typeof selector !== "string") return null;
  const trimmed = selector.trim();
  // Matches bare refs like "e51", "e123"
  if (/^e\d+$/.test(trimmed)) return trimmed;
  // Matches CSS-like abuse: "button[ref='e51']", "[ref=e51]", etc.
  const match = trimmed.match(/\[ref[=:]['"]?(e\d+)['"]?\]/);
  if (match) return match[1];
  return null;
}

async function callBrowserWithSelectorFallback(action, input = {}) {
  const selector = typeof input.selector === "string" ? input.selector.trim() : "";

  // If the model passed a snapshot ref as a selector, convert it to a proper
  // MCP call with the ref parameter instead of trying it as CSS.
  const snapshotRef = extractSnapshotRef(selector);
  if (snapshotRef) {
    try {
      return await callBrowser(action, { ref: snapshotRef, ...input, selector: undefined });
    } catch (refErr) {
      // If ref-based call also fails and this is a click, try Enter as fallback
      if (action === "click") {
        try {
          return await callBrowser("press_key", { key: "Enter" });
        } catch { /* fall through */ }
      }
      throw refErr;
    }
  }

  try {
    return await callBrowser(action, input);
  } catch (err) {
    if (!selector || !isPlaywrightRefValidationError(err)) {
      throw err;
    }

    if (action === "type") {
      const text = String(input.text ?? "");
      const submit = !!input.submit;
      const code = `async (page) => { const el = page.locator(${JSON.stringify(selector)}).first(); await el.waitFor({ state: 'visible' }); await el.fill(${JSON.stringify(text)}); ${submit ? "await el.press('Enter');" : ""} return { ok: true, fallback: 'run_code:type' }; }`;
      return await callBrowser("run_code", { code });
    }

    if (action === "click") {
      // Try CSS locator via run_code first
      try {
        const code = `async (page) => { const el = page.locator(${JSON.stringify(selector)}).first(); await el.waitFor({ state: 'visible' }); await el.click(); return { ok: true, fallback: 'run_code:click' }; }`;
        return await callBrowser("run_code", { code });
      } catch {
        // CSS locator also failed — try Enter as last resort
        try {
          return await callBrowser("press_key", { key: "Enter" });
        } catch { /* fall through to original error */ }
      }
      throw err;
    }

    throw err;
  }
}

async function callBrowser(action, payload = {}) {
  if (action === "close") {
    await closePlaywrightMcp();
    return { ok: true };
  }
  return await callPlaywrightMcp(action, payload);
}

/**
 * Execute a tool by name. Returns a string result.
 *
 * @param {string} name  — Tool name
 * @param {object} input — Tool input parameters
 * @param {function} [extraHandler] — Optional handler for agent-specific tools.
 *        Called with (name, input); return undefined to fall through to default.
 */
export async function executeTool(name, input, extraHandler) {
  switch (name) {
    case "read_file": {
      const fp = resolvePath(input.path);
      try { return redactSecrets(readFileSync(fp, "utf-8")); }
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
        const rawCommandLine = typeof input.commandLine === "string" ? input.commandLine.trim() : "";
        const inferredCommandLine =
          !rawCommandLine
          && typeof input.command === "string"
          && !Array.isArray(input.args)
          && /\s/.test(input.command)
            ? input.command.trim()
            : "";

        let stdout = "";
        let stderr = "";

        if (rawCommandLine || inferredCommandLine) {
          const shellLine = rawCommandLine || inferredCommandLine;
          ({ stdout, stderr } = await execFileAsync(
            "bash",
            ["-lc", shellLine],
            { cwd: WORKSPACE, timeout: COMMAND_TIMEOUT }
          ));
        } else {
          if (!input.command || typeof input.command !== "string") {
            return "Erro no run_command: informe command ou commandLine.";
          }
          ({ stdout, stderr } = await execFileAsync(
            input.command,
            Array.isArray(input.args) ? input.args : [],
            { cwd: WORKSPACE, timeout: COMMAND_TIMEOUT }
          ));
        }

        const raw = (stdout || "") + (stderr ? `\nSTDERR: ${stderr}` : "");
        return redactSecrets(raw);
      } catch (e) {
        const raw = `Saída ${e.code ?? 1}:\n${e.stdout ?? ""}\n${e.stderr ?? ""}`.trim();
        return redactSecrets(raw);
      }
    }
    case "batch_tools": {
      const calls = Array.isArray(input?.calls) ? input.calls : [];
      if (calls.length === 0) {
        return "Erro no batch_tools: informe calls com pelo menos uma chamada.";
      }
      if (calls.length > 6) {
        return "Erro no batch_tools: limite de 6 chamadas por lote.";
      }

      const jobs = calls.map(async (call, index) => {
        const tool = typeof call?.name === "string" ? call.name : "";
        const payload = call && typeof call.input === "object" && call.input !== null ? call.input : {};
        if (!tool) {
          return { index, tool: "", ok: false, output: "Nome da ferramenta ausente" };
        }
        if (tool === "batch_tools") {
          return { index, tool, ok: false, output: "batch_tools nao pode chamar a si mesma" };
        }
        try {
          const output = await executeTool(tool, payload, extraHandler);
          return { index, tool, ok: true, output };
        } catch (e) {
          return { index, tool, ok: false, output: String(e?.message || e || "erro desconhecido") };
        }
      });

      const settled = await Promise.all(jobs);
      return redactSecrets(JSON.stringify(settled, null, 2));
    }
    case "browser_navigate": {
      try {
        const result = await callBrowser("navigate", { url: input.url });
        return redactSecrets(JSON.stringify(result, null, 2));
      } catch (e) {
        return `Erro no browser_navigate: ${e.message}`;
      }
    }
    case "browser_snapshot": {
      try {
        const result = await callBrowser("snapshot", {});
        return redactSecrets(JSON.stringify(result, null, 2));
      } catch (e) {
        return `Erro no browser_snapshot: ${e.message}`;
      }
    }
    case "browser_click": {
      try {
        const result = await callBrowserWithSelectorFallback("click", { selector: input.selector });
        return redactSecrets(JSON.stringify(result, null, 2));
      } catch (e) {
        return `Erro no browser_click: ${e.message}`;
      }
    }
    case "browser_type": {
      try {
        const result = await callBrowserWithSelectorFallback("type", {
          selector: input.selector,
          text: input.text,
          submit: !!input.submit,
        });
        return redactSecrets(JSON.stringify(result, null, 2));
      } catch (e) {
        return `Erro no browser_type: ${e.message}`;
      }
    }
    case "browser_wait_for": {
      try {
        const result = await callBrowser("wait_for", {
          time: input.time,
          text: input.text,
          textGone: input.textGone,
        });
        return redactSecrets(JSON.stringify(result, null, 2));
      } catch (e) {
        return `Erro no browser_wait_for: ${e.message}`;
      }
    }
    case "browser_scroll": {
      try {
        const result = await callBrowser("scroll", {
          direction: input.direction,
          pixels: input.pixels,
          steps: input.steps,
          waitMs: input.waitMs,
        });
        return redactSecrets(JSON.stringify(result, null, 2));
      } catch (e) {
        return `Erro no browser_scroll: ${e.message}`;
      }
    }
    case "browser_screenshot": {
      try {
        const result = await callBrowser("screenshot", {
          filename: input.filename,
          fullPage: !!input.fullPage,
          type: input.type,
        });
        return redactSecrets(JSON.stringify(result, null, 2));
      } catch (e) {
        return `Erro no browser_screenshot: ${e.message}`;
      }
    }
    case "browser_run_code": {
      try {
        const result = await callBrowser("run_code", { code: input.code });
        return redactSecrets(JSON.stringify(result, null, 2));
      } catch (e) {
        return `Erro no browser_run_code: ${e.message}`;
      }
    }
    case "browser_evaluate": {
      try {
        const payload = { function: input.function };
        if (input.ref) payload.ref = input.ref;
        if (input.element) payload.element = input.element;
        const result = await callBrowser("evaluate", payload);
        return redactSecrets(JSON.stringify(result, null, 2));
      } catch (e) {
        return `Erro no browser_evaluate: ${e.message}`;
      }
    }
    case "browser_press_key": {
      try {
        const result = await callBrowser("press_key", { key: input.key });
        return redactSecrets(JSON.stringify(result, null, 2));
      } catch (e) {
        return `Erro no browser_press_key: ${e.message}`;
      }
    }
    case "browser_close": {
      try {
        const result = await callBrowser("close", {});
        return redactSecrets(JSON.stringify(result, null, 2));
      } catch (e) {
        return `Erro no browser_close: ${e.message}`;
      }
    }
    default: {
      // Let the caller handle agent-specific tools (web_fetch, rick_memory, etc.)
      if (extraHandler) {
        const result = await extraHandler(name, input);
        if (result !== undefined) return result;
      }
      return `Ferramenta desconhecida: ${name}`;
    }
  }
}
