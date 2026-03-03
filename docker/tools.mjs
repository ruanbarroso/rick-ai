/**
 * tools.mjs — Shared tool implementations for sub-agent and edit-agent
 *
 * Single source of truth for workspace helpers and tool execution.
 * Both agent.mjs and edit-agent.mjs import from this module.
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
        const { stdout, stderr } = await execFileAsync(
          input.command,
          input.args ?? [],
          { cwd: WORKSPACE, timeout: COMMAND_TIMEOUT }
        );
        const raw = (stdout || "") + (stderr ? `\nSTDERR: ${stderr}` : "");
        return redactSecrets(raw);
      } catch (e) {
        const raw = `Saída ${e.code ?? 1}:\n${e.stdout ?? ""}\n${e.stderr ?? ""}`.trim();
        return redactSecrets(raw);
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
