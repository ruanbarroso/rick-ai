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
  unlinkSync,
} from "fs";
import { join, relative, extname } from "path";
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

// ── In-memory todo list (for todo_write tool) ──────────────────────────────
const globalTodoList = [];

// ── Cascade replacer for edit_file (inspired by OpenCode) ───────────────────

/**
 * Apply a replacement with a cascade of strategies, from strictest to most lenient.
 * Returns { ok, content, strategy, replacements, error }.
 */
function cascadeReplace(content, oldStr, newStr, replaceAll = false) {
  // Strategy 1: Exact match
  if (content.includes(oldStr)) {
    const replaced = replaceAll
      ? content.split(oldStr).join(newStr)
      : content.replace(oldStr, newStr);
    const count = replaceAll ? (content.split(oldStr).length - 1) : 1;
    return { ok: true, content: replaced, strategy: "exact", replacements: count };
  }

  // Strategy 2: Line-trimmed match — trim each line before comparing
  {
    const result = lineTrimmedReplace(content, oldStr, newStr, replaceAll);
    if (result) return result;
  }

  // Strategy 3: Indentation-flexible — strip common leading whitespace
  {
    const result = indentationFlexibleReplace(content, oldStr, newStr, replaceAll);
    if (result) return result;
  }

  // Strategy 4: Whitespace-normalized — collapse all whitespace to single space
  {
    const result = whitespaceNormalizedReplace(content, oldStr, newStr, replaceAll);
    if (result) return result;
  }

  // Strategy 5: Escape-normalized — unescape \\n, \\t, \\\" etc.
  {
    const unescaped = oldStr
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'");
    if (unescaped !== oldStr && content.includes(unescaped)) {
      const replaced = replaceAll
        ? content.split(unescaped).join(newStr)
        : content.replace(unescaped, newStr);
      const count = replaceAll ? (content.split(unescaped).length - 1) : 1;
      return { ok: true, content: replaced, strategy: "escape-normalized", replacements: count };
    }
  }

  // Strategy 6: Block anchor match — use first/last lines as anchors
  {
    const result = blockAnchorReplace(content, oldStr, newStr);
    if (result) return result;
  }

  return { ok: false, error: "old_string nao encontrado (tentei 6 estrategias: exata, line-trimmed, indentation-flexible, whitespace-normalized, escape-normalized, block-anchor)" };
}

function lineTrimmedReplace(content, oldStr, newStr, replaceAll) {
  const contentLines = content.split("\n");
  const oldLines = oldStr.split("\n").map(l => l.trim());
  if (oldLines.length === 0) return null;

  const matches = [];
  for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
    let match = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (contentLines[i + j].trim() !== oldLines[j]) {
        match = false;
        break;
      }
    }
    if (match) matches.push(i);
  }

  if (matches.length === 0) return null;
  if (!replaceAll && matches.length > 1) return null; // ambiguous

  // Replace from bottom up to preserve indices
  const newLines = newStr.split("\n");
  const resultLines = [...contentLines];
  const indicesToReplace = replaceAll ? matches.reverse() : [matches[0]];
  for (const idx of indicesToReplace) {
    resultLines.splice(idx, oldLines.length, ...newLines);
  }
  return { ok: true, content: resultLines.join("\n"), strategy: "line-trimmed", replacements: indicesToReplace.length };
}

function indentationFlexibleReplace(content, oldStr, newStr, replaceAll) {
  const contentLines = content.split("\n");
  const oldLines = oldStr.split("\n");
  if (oldLines.length === 0) return null;

  // Strip common indentation from oldStr
  const nonEmptyOld = oldLines.filter(l => l.trim().length > 0);
  if (nonEmptyOld.length === 0) return null;
  const minIndent = Math.min(...nonEmptyOld.map(l => l.match(/^(\s*)/)[1].length));
  const strippedOld = oldLines.map(l => l.trim().length === 0 ? "" : l.slice(minIndent));

  const matches = [];
  for (let i = 0; i <= contentLines.length - strippedOld.length; i++) {
    // Determine actual indentation of the first non-empty content line
    const firstContentLine = contentLines[i];
    const actualIndent = firstContentLine.match(/^(\s*)/)[1];

    let match = true;
    for (let j = 0; j < strippedOld.length; j++) {
      const expected = strippedOld[j].trim().length === 0
        ? ""
        : actualIndent + strippedOld[j];
      if (contentLines[i + j].trimEnd() !== expected.trimEnd()) {
        match = false;
        break;
      }
    }
    if (match) matches.push({ index: i, indent: actualIndent });
  }

  if (matches.length === 0) return null;
  if (!replaceAll && matches.length > 1) return null;

  const resultLines = [...contentLines];
  const toReplace = replaceAll ? [...matches].reverse() : [matches[0]];
  for (const { index, indent } of toReplace) {
    const newLines = newStr.split("\n").map((l, i) => {
      if (l.trim().length === 0) return "";
      return indent + l.replace(/^(\s*)/, ""); // re-indent with actual file indentation
    });
    resultLines.splice(index, strippedOld.length, ...newLines);
  }
  return { ok: true, content: resultLines.join("\n"), strategy: "indentation-flexible", replacements: toReplace.length };
}

function whitespaceNormalizedReplace(content, oldStr, newStr, replaceAll) {
  const normalize = (s) => s.replace(/\s+/g, " ").trim();
  const normalizedOld = normalize(oldStr);
  if (!normalizedOld) return null;

  const contentLines = content.split("\n");
  // Build a running normalized version to find where the match is
  const normalizedContent = normalize(content);
  if (!normalizedContent.includes(normalizedOld)) return null;

  // Find line-based boundaries for the match
  // Try to find contiguous lines whose normalized form contains normalizedOld
  const matches = [];
  for (let start = 0; start < contentLines.length; start++) {
    let running = "";
    for (let end = start; end < contentLines.length && end < start + oldStr.split("\n").length + 2; end++) {
      running += (running ? " " : "") + contentLines[end].trim();
      if (normalize(running) === normalizedOld) {
        matches.push({ start, end: end + 1 });
        break;
      }
    }
  }

  if (matches.length === 0) return null;
  if (!replaceAll && matches.length > 1) return null;

  const resultLines = [...contentLines];
  const toReplace = replaceAll ? [...matches].reverse() : [matches[0]];
  for (const { start, end } of toReplace) {
    const indent = contentLines[start].match(/^(\s*)/)[1];
    const newLines = newStr.split("\n").map(l => l.trim() ? indent + l.trimStart() : "");
    resultLines.splice(start, end - start, ...newLines);
  }
  return { ok: true, content: resultLines.join("\n"), strategy: "whitespace-normalized", replacements: toReplace.length };
}

function blockAnchorReplace(content, oldStr, newStr) {
  // Use first and last lines of oldStr as anchors
  const oldLines = oldStr.split("\n");
  if (oldLines.length < 3) return null; // needs at least 3 lines for anchoring

  const firstLine = oldLines[0].trim();
  const lastLine = oldLines[oldLines.length - 1].trim();
  if (!firstLine || !lastLine) return null;

  const contentLines = content.split("\n");
  const candidates = [];

  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trim() !== firstLine) continue;
    // Look for the last line anchor within a reasonable range
    const maxRange = oldLines.length + 5;
    for (let j = i + oldLines.length - 2; j < Math.min(i + maxRange, contentLines.length); j++) {
      if (contentLines[j].trim() !== lastLine) continue;
      const blockLength = j - i + 1;
      // Check similarity: at least 50% of interior lines should match (by Levenshtein)
      const sim = blockSimilarity(
        contentLines.slice(i, j + 1).map(l => l.trim()),
        oldLines.map(l => l.trim()),
      );
      if (sim >= 0.5) {
        candidates.push({ start: i, end: j + 1, similarity: sim });
      }
    }
  }

  if (candidates.length === 0) return null;
  if (candidates.length > 1) {
    // Pick the best match
    candidates.sort((a, b) => b.similarity - a.similarity);
    if (candidates[0].similarity - candidates[1].similarity < 0.1) return null; // too ambiguous
  }

  const best = candidates[0];
  const indent = contentLines[best.start].match(/^(\s*)/)[1];
  const newLines = newStr.split("\n").map(l => l.trim() ? indent + l.trimStart() : "");
  const resultLines = [...contentLines];
  resultLines.splice(best.start, best.end - best.start, ...newLines);
  return { ok: true, content: resultLines.join("\n"), strategy: "block-anchor", replacements: 1 };
}

function blockSimilarity(linesA, linesB) {
  if (linesA.length === 0 && linesB.length === 0) return 1;
  if (linesA.length === 0 || linesB.length === 0) return 0;
  const maxLen = Math.max(linesA.length, linesB.length);
  let matches = 0;
  for (let i = 0; i < Math.min(linesA.length, linesB.length); i++) {
    if (linesA[i] === linesB[i]) {
      matches++;
    } else if (levenshteinSimilarity(linesA[i], linesB[i]) > 0.7) {
      matches += 0.7;
    }
  }
  return matches / maxLen;
}

function levenshteinSimilarity(a, b) {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  // Fast path: if lengths differ by more than 50%, low similarity
  if (Math.abs(a.length - b.length) > maxLen * 0.5) return 0;
  const dist = levenshteinDistance(a, b);
  return 1 - dist / maxLen;
}

function levenshteinDistance(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  // Use single-row DP for memory efficiency
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[n];
}

// ── Unified apply_patch parser/executor ────────────────────────────────────

function splitLines(text) {
  return String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

function fileExists(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function parseApplyPatch(patchText) {
  const lines = splitLines(patchText);
  if (lines.length < 2 || lines[0].trim() !== "*** Begin Patch") {
    throw new Error("Patch invalido: faltando cabecalho '*** Begin Patch'.");
  }

  const ops = [];
  let i = 1;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "*** End Patch") {
      return ops;
    }

    if (line.startsWith("*** Add File: ")) {
      const path = line.slice("*** Add File: ".length).trim();
      i += 1;
      const contentLines = [];
      while (i < lines.length && !lines[i].startsWith("*** ")) {
        if (!lines[i].startsWith("+")) {
          throw new Error(`Patch invalido em Add File (${path}): todas as linhas de conteudo devem iniciar com '+'.`);
        }
        contentLines.push(lines[i].slice(1));
        i += 1;
      }
      ops.push({ type: "add", path, content: contentLines.join("\n") });
      continue;
    }

    if (line.startsWith("*** Delete File: ")) {
      const path = line.slice("*** Delete File: ".length).trim();
      ops.push({ type: "delete", path });
      i += 1;
      continue;
    }

    if (line.startsWith("*** Update File: ")) {
      const path = line.slice("*** Update File: ".length).trim();
      i += 1;
      let moveTo = null;
      if (i < lines.length && lines[i].startsWith("*** Move to: ")) {
        moveTo = lines[i].slice("*** Move to: ".length).trim();
        i += 1;
      }

      const hunks = [];
      while (i < lines.length && !lines[i].startsWith("*** ")) {
        if (!lines[i].startsWith("@@")) {
          throw new Error(`Patch invalido em Update File (${path}): esperado cabecalho de hunk '@@'.`);
        }
        const header = lines[i];
        i += 1;
        const hunkLines = [];
        while (i < lines.length && !lines[i].startsWith("@@") && !lines[i].startsWith("*** ")) {
          hunkLines.push(lines[i]);
          i += 1;
        }
        hunks.push({ header, lines: hunkLines });
      }
      ops.push({ type: "update", path, moveTo, hunks });
      continue;
    }

    throw new Error(`Patch invalido: cabecalho desconhecido '${line}'.`);
  }

  throw new Error("Patch invalido: faltando terminador '*** End Patch'.");
}

function findSequence(lines, sequence, fromIndex = 0) {
  if (sequence.length === 0) return fromIndex;
  for (let i = Math.max(0, fromIndex); i <= lines.length - sequence.length; i++) {
    let ok = true;
    for (let j = 0; j < sequence.length; j++) {
      if (lines[i + j] !== sequence[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

function applyUnifiedHunks(content, hunks, filePathForError) {
  let lines = splitLines(content);
  let cursor = 0;

  for (let hunkIndex = 0; hunkIndex < hunks.length; hunkIndex++) {
    const hunk = hunks[hunkIndex];
    const oldSeq = [];
    const newSeq = [];

    for (const rawLine of hunk.lines) {
      if (!rawLine) {
        oldSeq.push("");
        newSeq.push("");
        continue;
      }
      const prefix = rawLine[0];
      const payload = rawLine.slice(1);
      if (prefix === " ") {
        oldSeq.push(payload);
        newSeq.push(payload);
      } else if (prefix === "-") {
        oldSeq.push(payload);
      } else if (prefix === "+") {
        newSeq.push(payload);
      } else if (prefix === "\\") {
        // "\\ No newline at end of file" marker — ignore
      } else {
        throw new Error(`Patch invalido em ${filePathForError} no hunk ${hunkIndex + 1}: prefixo '${prefix}' nao suportado.`);
      }
    }

    const matchAtCursor = findSequence(lines, oldSeq, cursor);
    const matchAnywhere = matchAtCursor >= 0 ? matchAtCursor : findSequence(lines, oldSeq, 0);
    if (matchAnywhere < 0) {
      throw new Error(`Falha ao aplicar patch em ${filePathForError}: contexto do hunk ${hunkIndex + 1} nao encontrado.`);
    }

    lines.splice(matchAnywhere, oldSeq.length, ...newSeq);
    cursor = matchAnywhere + newSeq.length;
  }

  return lines.join("\n");
}

function applyPatchText(patchText) {
  const ops = parseApplyPatch(patchText);
  const virtualWrites = new Map();
  const virtualDeletes = new Set();
  const changed = [];

  const readVirtual = (fp) => {
    if (virtualWrites.has(fp)) return virtualWrites.get(fp);
    if (virtualDeletes.has(fp)) throw new Error(`Arquivo nao existe (marcado para delete): ${fp}`);
    if (!fileExists(fp)) throw new Error(`Arquivo nao encontrado: ${fp}`);
    return readFileSync(fp, "utf-8");
  };

  const existsVirtual = (fp) => {
    if (virtualDeletes.has(fp)) return false;
    if (virtualWrites.has(fp)) return true;
    return fileExists(fp);
  };

  for (const op of ops) {
    const fromPath = resolvePath(op.path);
    if (op.type === "add") {
      if (existsVirtual(fromPath)) {
        throw new Error(`Add File falhou: arquivo ja existe (${fromPath}).`);
      }
      virtualWrites.set(fromPath, op.content);
      virtualDeletes.delete(fromPath);
      changed.push({ type: "add", path: fromPath });
      continue;
    }

    if (op.type === "delete") {
      if (!existsVirtual(fromPath)) {
        throw new Error(`Delete File falhou: arquivo nao existe (${fromPath}).`);
      }
      virtualWrites.delete(fromPath);
      virtualDeletes.add(fromPath);
      changed.push({ type: "delete", path: fromPath });
      continue;
    }

    if (op.type === "update") {
      const original = readVirtual(fromPath);
      const updated = applyUnifiedHunks(original, op.hunks, fromPath);
      const toPath = op.moveTo ? resolvePath(op.moveTo) : fromPath;

      if (toPath !== fromPath && existsVirtual(toPath)) {
        throw new Error(`Move to falhou: destino ja existe (${toPath}).`);
      }

      virtualWrites.set(toPath, updated);
      virtualDeletes.delete(toPath);

      if (toPath !== fromPath) {
        virtualWrites.delete(fromPath);
        virtualDeletes.add(fromPath);
        changed.push({ type: "move", from: fromPath, to: toPath });
      } else {
        changed.push({ type: "update", path: fromPath });
      }
      continue;
    }
  }

  // Commit writes first, then deletes (best-effort atomicity after full validation)
  for (const [fp, content] of virtualWrites.entries()) {
    const dir = fp.substring(0, fp.lastIndexOf("/"));
    if (dir) mkdirSync(dir, { recursive: true });
    writeFileSync(fp, content, "utf-8");
  }
  for (const fp of virtualDeletes.values()) {
    if (virtualWrites.has(fp)) continue;
    if (fileExists(fp)) unlinkSync(fp);
  }

  return changed;
}

// ── Glob: recursive file pattern matching ───────────────────────────────────

const GLOB_IGNORE = new Set(["node_modules", ".git", "__pycache__", ".next", "dist", "build", ".cache", "coverage", ".venv", "venv"]);
const GLOB_MAX_RESULTS = 200;

function globRecursive(dir, pattern, results = [], depth = 0) {
  if (depth > 12 || results.length >= GLOB_MAX_RESULTS) return results;
  const regexes = globToRegexes(pattern);
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= GLOB_MAX_RESULTS) break;
      if (GLOB_IGNORE.has(entry.name)) continue;
      if (entry.name.startsWith(".") && !pattern.startsWith(".")) continue;
      const fullPath = join(dir, entry.name);
      const relPath = relative(WORKSPACE, fullPath);
      if (entry.isDirectory()) {
        // If pattern contains **, recurse into all directories
        globRecursive(fullPath, pattern, results, depth + 1);
      } else if (entry.isFile()) {
        if (regexes.some((rx) => rx.test(relPath) || rx.test(entry.name))) {
          results.push(fullPath);
        }
      }
    }
  } catch { /* permission denied or similar */ }
  return results;
}

function expandBracePatterns(pattern) {
  const text = String(pattern || "");
  const start = text.indexOf("{");
  if (start < 0) return [text];
  const end = text.indexOf("}", start + 1);
  if (end < 0) return [text];
  const before = text.slice(0, start);
  const after = text.slice(end + 1);
  const body = text.slice(start + 1, end);
  const options = body.split(",").map((s) => s.trim()).filter(Boolean);
  if (options.length === 0) return [text];
  const expanded = [];
  for (const opt of options) {
    for (const tail of expandBracePatterns(after)) {
      expanded.push(`${before}${opt}${tail}`);
    }
  }
  return expanded;
}

function globToRegex(pattern) {
  // Convert glob pattern to regex
  let regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")  // escape regex special chars except * and ?
    .replace(/\*\*/g, "§DOUBLESTAR§")
    .replace(/\*/g, "[^/]*")
    .replace(/§DOUBLESTAR§/g, ".*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`(^|/)${regex}$`, "i");
}

function globToRegexes(pattern) {
  const expanded = expandBracePatterns(pattern);
  return expanded.map((p) => globToRegex(p));
}

function sortPathsByMtimeDesc(paths) {
  return [...paths].sort((a, b) => {
    let am = 0;
    let bm = 0;
    try { am = statSync(a).mtimeMs; } catch { am = 0; }
    try { bm = statSync(b).mtimeMs; } catch { bm = 0; }
    return bm - am;
  });
}

// ── Grep: recursive content search ─────────────────────────────────────────

const GREP_MAX_LINE_LEN = 500;

function grepRecursive(dir, pattern, includeFilter, maxResults, results = [], depth = 0) {
  if (depth > 12 || results.length >= maxResults) return results;
  let regex;
  try {
    regex = new RegExp(pattern, "i");
  } catch {
    return [{ file: "(erro)", line: 0, content: `Regex invalida: ${pattern}` }];
  }
  const includeRegexes = includeFilter ? globToRegexes(includeFilter) : null;

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= maxResults) break;
      if (GLOB_IGNORE.has(entry.name)) continue;
      if (entry.name.startsWith(".")) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        grepRecursive(fullPath, pattern, includeFilter, maxResults, results, depth + 1);
      } else if (entry.isFile()) {
        if (
          includeRegexes
          && !includeRegexes.some((rx) => rx.test(entry.name) || rx.test(relative(WORKSPACE, fullPath)))
        ) continue;
        // Skip binary files by extension
        const ext = extname(entry.name).toLowerCase();
        if ([".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".eot", ".zip", ".tar", ".gz", ".pdf", ".exe", ".dll", ".so", ".dylib", ".bin", ".lock"].includes(ext)) continue;
        try {
          const stat = statSync(fullPath);
          if (stat.size > 1_000_000) continue; // skip files > 1MB
          const content = readFileSync(fullPath, "utf-8");
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (results.length >= maxResults) break;
            if (regex.test(lines[i])) {
              const lineContent = lines[i].length > GREP_MAX_LINE_LEN
                ? lines[i].slice(0, GREP_MAX_LINE_LEN) + "..."
                : lines[i];
              results.push({ file: fullPath, line: i + 1, content: lineContent.trim() });
            }
          }
        } catch { /* binary or permission denied */ }
      }
    }
  } catch { /* permission denied or similar */ }
  return results;
}

// ── Smart output truncation ─────────────────────────────────────────────────

const TRUNCATE_MAX_LINES = 2000;
const TRUNCATE_MAX_BYTES = 51200; // 50 KB

export function truncateToolOutput(text) {
  if (!text || typeof text !== "string") return text;
  if (text.length <= TRUNCATE_MAX_BYTES) {
    const lineCount = text.split("\n").length;
    if (lineCount <= TRUNCATE_MAX_LINES) return text;
  }

  const lines = text.split("\n");
  if (lines.length <= TRUNCATE_MAX_LINES && text.length <= TRUNCATE_MAX_BYTES) return text;

  // Keep first 60% and last 40% of allowed lines
  const keepFirst = Math.floor(TRUNCATE_MAX_LINES * 0.6);
  const keepLast = TRUNCATE_MAX_LINES - keepFirst;
  const omitted = lines.length - keepFirst - keepLast;

  const head = lines.slice(0, keepFirst);
  const tail = lines.slice(lines.length - keepLast);
  return [
    ...head,
    `\n... [${omitted} linhas omitidas de ${lines.length} totais] ...\n`,
    ...tail,
  ].join("\n");
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
      try {
        const raw = readFileSync(fp, "utf-8");
        // Apply offset/limit if provided (like OpenCode's Read tool)
        if (typeof input.offset === "number" || typeof input.limit === "number") {
          const lines = raw.split("\n");
          const offset = Math.max(0, (input.offset || 1) - 1); // 1-indexed
          const limit = input.limit || 2000;
          const sliced = lines.slice(offset, offset + limit);
          const numbered = sliced.map((l, i) => `${offset + i + 1}: ${l}`).join("\n");
          const total = lines.length;
          const header = total > limit ? `(mostrando linhas ${offset + 1}-${Math.min(offset + limit, total)} de ${total})\n` : "";
          return truncateToolOutput(redactSecrets(header + numbered));
        }
        return truncateToolOutput(redactSecrets(raw));
      }
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
        const oldStr = input.old_string;
        const newStr = input.new_string;
        const doReplaceAll = !!input.replaceAll;

        const result = cascadeReplace(content, oldStr, newStr, doReplaceAll);
        if (!result.ok) {
          return `Erro: ${result.error} em ${fp}`;
        }
        writeFileSync(fp, result.content, "utf-8");
        const strategyHint = result.strategy !== "exact" ? ` (via ${result.strategy})` : "";
        const countHint = result.replacements > 1 ? ` (${result.replacements} ocorrencias)` : "";
        return `Arquivo editado: ${fp}${strategyHint}${countHint}`;
      } catch (e) { return `Erro ao editar arquivo: ${e.message}`; }
    }
    case "apply_patch": {
      try {
        const patchText = String(input.patchText ?? "");
        if (!patchText.trim()) return "Erro no apply_patch: patchText vazio.";
        const changed = applyPatchText(patchText);
        if (changed.length === 0) return "Patch aplicado sem alteracoes.";
        const summary = changed.map((item) => {
          if (item.type === "move") {
            return `- move: ${relative(WORKSPACE, item.from)} -> ${relative(WORKSPACE, item.to)}`;
          }
          return `- ${item.type}: ${relative(WORKSPACE, item.path)}`;
        }).join("\n");
        return `Patch aplicado com sucesso (${changed.length} operacoes):\n${summary}`;
      } catch (e) {
        return `Erro no apply_patch: ${e.message}`;
      }
    }
    case "list_directory": {
      const dp = resolvePath(input.path);
      const entries = listWorkspace(dp);
      return entries.length ? entries.join("\n") : "(diretório vazio)";
    }
    case "glob": {
      const pattern = input.pattern;
      const searchDir = resolvePath(input.path || "");
      if (!pattern) return "Erro: parametro 'pattern' obrigatorio.";
      try {
        const matches = sortPathsByMtimeDesc(globRecursive(searchDir, pattern));
        if (matches.length === 0) return `Nenhum arquivo encontrado para o padrão: ${pattern}`;
        return matches.map(fp => relative(WORKSPACE, fp)).join("\n");
      } catch (e) { return `Erro no glob: ${e.message}`; }
    }
    case "grep": {
      const pattern = input.pattern;
      const searchDir = resolvePath(input.path || "");
      const include = input.include || "";
      if (!pattern) return "Erro: parametro 'pattern' obrigatorio.";
      try {
        const results = grepRecursive(searchDir, pattern, include, input.maxResults || 50);
        if (results.length === 0) return `Nenhum resultado para o padrão: ${pattern}`;
        const sorted = [...results].sort((a, b) => {
          let am = 0;
          let bm = 0;
          try { am = statSync(a.file).mtimeMs; } catch { am = 0; }
          try { bm = statSync(b.file).mtimeMs; } catch { bm = 0; }
          if (bm !== am) return bm - am;
          if (a.file !== b.file) return a.file.localeCompare(b.file);
          return a.line - b.line;
        });
        return sorted.map(r => `${relative(WORKSPACE, r.file)}:${r.line}: ${r.content}`).join("\n");
      } catch (e) { return `Erro no grep: ${e.message}`; }
    }
    case "todo_write": {
      // The todo_write tool stores tasks in-memory for the LLM to track progress.
      // Results are emitted as status messages to the session viewer.
      const todos = Array.isArray(input?.todos) ? input.todos : [];
      if (todos.length === 0) return "Erro: informe pelo menos um todo.";
      globalTodoList.length = 0;
      globalTodoList.push(...todos);
      const summary = todos.map((t, i) => {
        const icon = t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[>]" : "[ ]";
        return `${icon} ${t.content}`;
      }).join("\n");
      return `Todo list atualizada:\n${summary}`;
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
        return truncateToolOutput(redactSecrets(raw));
      } catch (e) {
        const raw = `Saída ${e.code ?? 1}:\n${e.stdout ?? ""}\n${e.stderr ?? ""}`.trim();
        return truncateToolOutput(redactSecrets(raw));
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
