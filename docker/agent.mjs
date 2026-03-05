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
import { readFile } from "node:fs/promises";
import { WORKSPACE, executeTool } from "./tools.mjs";
import { coreToolDeclarations } from "./tool-declarations.mjs";
import {
  rickApiGet, rickApiPost, agentToolHandler as sharedAgentToolHandler,
  buildAgentToolDeclarations,
  LLM_TIMEOUT_MS, MAX_TIMEOUT_RETRIES,
} from "./rick-api.mjs";
import { redactSecrets } from "./tools.mjs";
import {
  looksLikeTechnicalCompletion, looksLikeTechnicalActionRequest,
  looksLikeExecutionNowRequest, looksLikeConcreteExecutionRequest,
  looksLikeExecutionClaim, looksLikeExecutionPromise, looksLikePlanDraftRequest,
  looksLikeFakeAccessBlockClaim, acknowledgesPriorExecution,
  isContinuationRequest, hasExecutionReceipt,
  summarizeCommandInput,
  detectBlockedCommand, detectPlanningOnlyToolBlock as detectPlanningBlock,
  parseTurnPolicy as parseTurnPolicyPure, missingExpectedActions as missingExpectedActionsPure,
  buildPlanningOnlyPrompt, buildForcedExecutionPrompt,
  buildContinuationPrompt as buildContinuationPromptPure,
  buildNoExecutionGuardMessage,
  shouldForceExecutionRetry as shouldForceExecutionRetryPure,
  shouldSuppressInterimClaim,
} from "./policy.mjs";
import {
  refreshSystemPromptCache as refreshPromptCache,
  getGeminiSystemPrompt, getOpenAISystemPrompt,
  getOpenAICodexInstructions, getClaudeSystemPrompt,
} from "./prompt.mjs";

const SENSITIVE_TOOL_PREVIEW = new Set(["rick_memory", "rick_search"]);

function redactUserVisibleText(value) {
  let text = String(value ?? "");
  text = redactSecrets(text);

  // Key/value secrets in prose or logs: "senha: ...", "token=...", etc.
  text = text.replace(
    /((?:senha|password|pass|token|api[_ -]?key|secret|chave(?:\s+de\s+acesso)?)\s*[:=]\s*)([^\s,;`"'\\]+)/gi,
    "$1[REDACTED]",
  );

  // Common token formats that may come from memories or command output.
  text = text.replace(/\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g, "[REDACTED]");

  // URLs with embedded credentials: https://user:pass@host
  text = text.replace(/(https?:\/\/[^\s:/@]+:)([^@\s/]+)(@)/gi, "$1[REDACTED]$3");

  // JSON payloads with explicit password/token fields.
  text = text.replace(/("(?:password|senha|token|apiKey|secret)"\s*:\s*")([^"]+)(")/gi, "$1[REDACTED]$3");
  return text;
}

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
  if (shouldSuppressInterimExecutionClaim(text)) return;
  emit({ type: "message", text: redactUserVisibleText(text) });
}

function emitStatus(message) {
  // Don't emit if this message has been superseded
  if (isCurrentSuperseded()) return;
  emit({ type: "status", message: redactUserVisibleText(message) });
}

function emitDone(result) {
  // Don't emit if this message has been superseded
  if (isCurrentSuperseded()) return;
  emit({ type: "done", result: redactUserVisibleText(result) });
}

function emitWaitingUser(result) {
  // Don't emit if this message has been superseded
  if (isCurrentSuperseded()) return;
  emit({ type: "waiting_user", result: redactUserVisibleText(result) });
}

function emitError(message) {
  // Don't emit if this message has been superseded
  if (isCurrentSuperseded()) return;
  emit({ type: "error", message: redactUserVisibleText(message) });
}

function emitModelActive(modelId, modelName) {
  if (isCurrentSuperseded()) return;
  emit({ type: "model_active", modelId, modelName: redactUserVisibleText(modelName) });
}

function emitProviderError(message) {
  if (isCurrentSuperseded()) return;
  emit({ type: "provider_error", message: redactUserVisibleText(message) });
}

function emitFallbackUsed(providerName, depth) {
  if (isCurrentSuperseded()) return;
  emit({ type: "fallback_used", providerName: redactUserVisibleText(providerName), depth });
}

function emitProviderRetry(providerName, reason) {
  if (isCurrentSuperseded()) return;
  emit({ type: "provider_retry", providerName: redactUserVisibleText(providerName), reason });
}

function emitContextCompacted(removedMessages, summaryChars) {
  if (isCurrentSuperseded()) return;
  emit({ type: "context_compacted", removedMessages, summaryChars });
}

let toolCallSequence = 0;

const MAX_TOOL_CALLS_PER_TURN = 80;
const MAX_REPEAT_SAME_TOOL_CALL = 3;
const MAX_STEPS_MESSAGE = "Limite maximo de passos desta rodada foi atingido. Parei as ferramentas para evitar loop; se quiser, me diga o proximo foco e eu continuo em uma nova rodada.";

let currentTurnStats = null;
let currentTurnPolicy = {
  allowCommit: false,
  allowPush: false,
  allowPr: false,
  executionRequired: false,
  expectedActions: { gitPull: false, gitCommit: false, gitPush: false },
  planningOnly: false,
  executionMode: "build",
};
let pendingContinuation = null;
let recentGitPolicy = {
  allowCommit: false,
  allowPush: false,
  allowPr: false,
  expiresAt: 0,
};

function nextToolCallId() {
  toolCallSequence += 1;
  return `tool_${toolCallSequence}`;
}

function toPreview(text, max = 180) {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > max ? `${normalized.slice(0, max - 3)}...` : normalized;
}

function emitToolCallStart(callId, name, input) {
  if (isCurrentSuperseded()) return;
  emit({ type: "tool_call", event: "start", callId, name, input });
}

function emitToolCallCompleted(callId, name, durationMs, outputPreview) {
  if (isCurrentSuperseded()) return;
  const safePreview = SENSITIVE_TOOL_PREVIEW.has(name)
    ? "resultado ocultado por seguranca"
    : redactUserVisibleText(outputPreview);
  emit({
    type: "tool_call",
    event: "completed",
    callId,
    name,
    durationMs,
    outputPreview: safePreview,
  });
}

function emitToolCallError(callId, name, durationMs, message) {
  if (isCurrentSuperseded()) return;
  emit({
    type: "tool_call",
    event: "error",
    callId,
    name,
    durationMs,
    message: redactUserVisibleText(message),
  });
}

// ── Thin wrappers around imported policy functions (pass module-level state) ─

function shouldSuppressInterimExecutionClaim(text) {
  return shouldSuppressInterimClaim(text, currentTurnPolicy, currentTurnStats);
}

function parseTurnPolicy(text) {
  const result = parseTurnPolicyPure(text, recentGitPolicy);
  if (result.updatedGitPolicy !== recentGitPolicy) {
    recentGitPolicy = result.updatedGitPolicy;
  }
  const { updatedGitPolicy: _, ...policy } = result;
  return policy;
}

function missingExpectedActions() {
  return missingExpectedActionsPure(currentTurnPolicy, currentTurnStats);
}

function buildContinuationPrompt(userText) {
  return buildContinuationPromptPure(userText, pendingContinuation);
}

function shouldForceExecutionRetry(taskText, resultText) {
  return shouldForceExecutionRetryPure(taskText, resultText, currentTurnPolicy, currentTurnStats);
}

function detectBlockedGitAction(toolName, input) {
  return detectBlockedCommand(toolName, input, currentTurnPolicy);
}

function detectPlanningOnlyToolBlock(toolName) {
  return detectPlanningBlock(toolName, currentTurnPolicy);
}

function trimForReceipt(text, max = 90) {
  const normalized = redactUserVisibleText(String(text || "")).replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > max ? `${normalized.slice(0, max - 3)}...` : normalized;
}

function snapshotPendingContinuation(userText) {
  const tools = currentTurnStats ? Array.from(currentTurnStats.toolNames).slice(0, 6).join(", ") : "";
  const cmds = currentTurnStats ? currentTurnStats.commands.slice(0, 3).join("; ") : "";
  const evidence = [
    tools ? `Ferramentas usadas antes de parar: ${tools}.` : "",
    cmds ? `Comandos recentes: ${cmds}.` : "",
  ].filter(Boolean).join(" ");

  pendingContinuation = {
    userText: trimForReceipt(userText, 240),
    evidence,
    createdAt: Date.now(),
  };
}

function toolFingerprint(name, input) {
  const base = { name };
  if (!input || typeof input !== "object") return JSON.stringify(base);
  const compact = {
    command: input.command,
    args: input.args,
    path: input.path ?? input.filePath ?? input.file_path,
    pattern: input.pattern,
    url: input.url,
    query: input.query,
    description: input.description,
  };
  return JSON.stringify({ ...base, ...compact });
}

function collectTurnEvidence(toolName, input) {
  if (!currentTurnStats) return;
  currentTurnStats.phase = "executing";
  currentTurnStats.toolNames.add(toolName);

  const maybePath = input && typeof input === "object"
    ? (input.path || input.filePath || input.file_path || input.notebook_path)
    : null;
  if (typeof maybePath === "string" && maybePath.trim()) {
    currentTurnStats.changedPaths.add(maybePath.trim());
  }

  if (toolName === "run_command") {
    const cmd = trimForReceipt(summarizeCommandInput(input), 120);
    if (!cmd) return;

    if (currentTurnStats.commands.length < 6) {
      currentTurnStats.commands.push(cmd);
    }
    if (/\bgit\s+pull\b|\bpull\s+--rebase\b/.test(cmd)) currentTurnStats.completedActions.gitPull = true;
    if (/\bgit\s+commit\b/.test(cmd)) currentTurnStats.completedActions.gitCommit = true;
    if (/\bgit\s+push\b/.test(cmd)) currentTurnStats.completedActions.gitPush = true;
    if (/(npx\s+tsc|npm\s+test|pnpm\s+test|yarn\s+test|bun\s+test|pytest|go\s+test|cargo\s+test|mvn\s+test|gradle\s+test|npm\s+run\s+build|pnpm\s+build|yarn\s+build|eslint|vitest|jest)/.test(cmd)) {
      if (currentTurnStats.validations.length < 4) {
        currentTurnStats.validations.push(cmd);
      }
    }
  }
}

function buildFallbackCarryoverContext(baseTaskText) {
  if (!currentTurnStats || (currentTurnStats.executedToolCalls ?? 0) === 0) {
    return baseTaskText;
  }

  const files = Array.from(currentTurnStats.changedPaths).slice(-6).map((p) => trimForReceipt(p, 70));
  const cmds = currentTurnStats.commands.slice(-4);
  const tools = Array.from(currentTurnStats.toolNames).slice(-8);

  const lines = [
    "[CONTEXTO_DE_FALLBACK]",
    "A rodada atual ja teve execucao de ferramentas antes do fallback.",
    tools.length > 0 ? `Ferramentas usadas: ${tools.join(", ")}.` : "",
    files.length > 0 ? `Arquivos/paths envolvidos: ${files.join(", ")}.` : "",
    cmds.length > 0 ? `Comandos recentes: ${cmds.join("; ")}.` : "",
    "Continue da etapa atual e NAO reinicie a tarefa do zero.",
  ].filter(Boolean);

  return `${baseTaskText}\n\n${lines.join("\n")}`;
}

function buildExecutionReceipt() {
  if (!currentTurnStats) return "";

  const files = Array.from(currentTurnStats.changedPaths)
    .map((p) => trimForReceipt(p, 80))
    .filter(Boolean);
  const cmds = currentTurnStats.commands.slice(0, 4);
  const checks = currentTurnStats.validations.slice(0, 3);

  const lines = ["", "Evidencias de execucao:"];
  if (files.length > 0) lines.push(`- Arquivos alterados: ${files.map((f) => `\`${f}\``).join(", ")}`);
  if (cmds.length > 0) lines.push(`- Comandos executados: ${cmds.map((c) => `\`${c}\``).join("; ")}`);
  if (checks.length > 0) {
    currentTurnStats.phase = "validating";
    lines.push(`- Validacoes executadas: ${checks.map((c) => `\`${c}\``).join("; ")}`);
  }
  if (files.length === 0 && cmds.length === 0) {
    lines.push(`- Ferramentas executadas: ${Array.from(currentTurnStats.toolNames).join(", ") || "(nenhuma registrada)"}`);
  }

  return lines.join("\n");
}

function looksToolErrorOutput(toolName, output) {
  const text = String(output || "").trim();
  if (!text) return false;
  if (/^Erro\b/i.test(text)) return true;
  if (toolName === "run_command" && /^Sa[ií]da\s+\d+:/i.test(text)) {
    return !/^Sa[ií]da\s+0:/i.test(text);
  }
  return false;
}

// requestedFullHistory — imported from policy.mjs

// looksLikeFullCoverageClaim — imported from policy.mjs

function captureBrowserProgress(toolName, output) {
  if (!currentTurnStats) return;
  if (toolName !== "browser_snapshot" && toolName !== "browser_scroll") return;

  let data = null;
  try {
    data = JSON.parse(String(output || ""));
  } catch {
    return;
  }
  const scroll = data?.scroll;
  if (typeof scroll?.atBottom === "boolean") {
    currentTurnStats.browserAtBottom = scroll.atBottom;
  }
  if (toolName === "browser_scroll") {
    currentTurnStats.browserScrolled = true;
  }
}

function isMaxStepsError(err) {
  return !!err && (err.code === "MAX_STEPS_REACHED" || err.message === "MAX_STEPS_REACHED");
}

// buildNoExecutionGuardMessage — imported from policy.mjs

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

async function runToolWithLifecycle(name, input) {
  if (!currentTurnStats) {
    currentTurnStats = {
      phase: "planning",
      toolCalls: 0,
      toolNames: new Set(),
      changedPaths: new Set(),
      commands: [],
      validations: [],
      executionTrail: [],
      browserScrolled: false,
      browserAtBottom: false,
      toolErrors: 0,
      executedToolCalls: 0,
      blockedByPolicyReason: "",
      completedActions: { gitPull: false, gitCommit: false, gitPush: false },
      lastToolFingerprint: "",
      repeatedToolCount: 0,
      maxStepsReached: false,
    };
  }

  if (currentTurnStats.toolCalls >= MAX_TOOL_CALLS_PER_TURN) {
    currentTurnStats.maxStepsReached = true;
    const err = new Error("MAX_STEPS_REACHED");
    err.code = "MAX_STEPS_REACHED";
    throw err;
  }

  const callId = nextToolCallId();
  const started = Date.now();

  const planningBlockReason = detectPlanningOnlyToolBlock(name);
  if (planningBlockReason) {
    emitToolCallError(callId, name, Date.now() - started, planningBlockReason);
    return planningBlockReason;
  }

  emitToolCallStart(callId, name, input);
  currentTurnStats.toolCalls += 1;
  currentTurnStats.toolNames.add(name);

  const fp = toolFingerprint(name, input);
  if (currentTurnStats.lastToolFingerprint === fp) {
    currentTurnStats.repeatedToolCount += 1;
  } else {
    currentTurnStats.lastToolFingerprint = fp;
    currentTurnStats.repeatedToolCount = 1;
  }

  if (currentTurnStats.repeatedToolCount >= MAX_REPEAT_SAME_TOOL_CALL) {
    // Don't kill the turn — return a warning so the model can try a different approach.
    // Only escalate to MAX_STEPS if total tool calls also exceed the hard cap.
    const warning = `DOOM_LOOP: a mesma ferramenta (${name}) com os mesmos argumentos foi chamada ${MAX_REPEAT_SAME_TOOL_CALL} vezes consecutivas sem progresso. Tente uma abordagem diferente (outro seletor, outro comando, outra ferramenta). Se nao houver alternativa, reporte o problema ao usuario.`;
    emitToolCallError(callId, name, Date.now() - started, warning);
    // Reset the counter so the model gets another chance with different args
    currentTurnStats.repeatedToolCount = 0;
    currentTurnStats.lastToolFingerprint = "";
    return warning;
  }

  const blockedReason = detectBlockedGitAction(name, input);
  if (blockedReason) {
    currentTurnStats.blockedByPolicyReason = blockedReason;
    emitToolCallError(callId, name, Date.now() - started, blockedReason);
    return blockedReason;
  }

  try {
    currentTurnStats.executedToolCalls += 1;
    const result = await runTool(name, input);
    const output = String(result);
    collectTurnEvidence(name, input);
    captureBrowserProgress(name, output);
    if (currentTurnStats.executionTrail.length < 16) {
      const inputPreview = trimForReceipt(summarizeCommandInput(input) || (input?.path ?? input?.filePath ?? input?.url ?? ""), 90);
      const outputPreview = trimForReceipt(output, 90);
      currentTurnStats.executionTrail.push({ name, input: inputPreview, output: outputPreview });
    }
    if (looksToolErrorOutput(name, output)) {
      currentTurnStats.toolErrors += 1;
      emitToolCallError(callId, name, Date.now() - started, toPreview(output));
    } else {
      emitToolCallCompleted(callId, name, Date.now() - started, toPreview(output));
    }
    return output;
  } catch (err) {
    const message = err?.message || String(err || "Erro desconhecido na ferramenta");
    if (currentTurnStats) currentTurnStats.toolErrors += 1;
    emitToolCallError(callId, name, Date.now() - started, message);
    throw err;
  }
}

// ── Agent name (used in tool descriptions and system prompt) ────────────────
const agentName = process.env.AGENT_NAME || "Rick";

// ── Tool declarations (core + agent-specific from rick-api.mjs) ─────────────
const toolDeclarations = [...coreToolDeclarations, ...buildAgentToolDeclarations(agentName)];

const toolNames = toolDeclarations.map((t) => t.name);

// ── System prompt (delegated to prompt.mjs) ────────────────────────────────
// Prompt construction, instruction file discovery, and caching are in prompt.mjs.
// refreshSystemPromptCache, getGeminiSystemPrompt, getOpenAISystemPrompt,
// getOpenAICodexInstructions, getClaudeSystemPrompt are imported at the top.

async function refreshSystemPromptCache(force = false) {
  return refreshPromptCache(WORKSPACE, agentName, toolNames, force);
}

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
      systemInstruction: { parts: [{ text: getGeminiSystemPrompt() }] },
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

// Rolling compacted summary of older transcript messages.
// Keeps context continuity without letting raw history grow forever.
let conversationSummary = "";

// Context compaction/pruning knobs.
const CONTEXT_MAX_ESTIMATED_TOKENS = 70_000;
const CONTEXT_KEEP_RECENT_MESSAGES = 16; // keep recent 8 user/assistant turns raw
const CONTEXT_SUMMARY_MAX_CHARS = 12_000;
const PROVIDER_HISTORY_MAX_CHARS = 220_000;

function estimateTextTokens(value) {
  // Rough estimate: ~4 chars/token for mixed PT/EN prose and JSON-ish payloads.
  const chars = typeof value === "number" ? Math.max(0, value) : String(value || "").length;
  return Math.ceil(chars / 4);
}

function normalizeForSummary(text, maxLen = 220) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "(vazio)";
  return normalized.length > maxLen ? `${normalized.slice(0, maxLen)}...` : normalized;
}

function summarizeTranscriptChunk(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  const lines = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const who = msg.role === "user" ? "Usuario" : "Agente";
    lines.push(`${i + 1}. [${who}] ${normalizeForSummary(msg.content, 420)}`);
  }
  return `Transcricao compactada (factual):\n${lines.join("\n")}`;
}

function capSummaryByLines(text, maxChars) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  if (raw.length <= maxChars) return raw;

  const lines = raw.split("\n");
  const kept = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const extra = line.length + (kept.length > 0 ? 1 : 0);
    if (used + extra > maxChars) break;
    kept.unshift(line);
    used += extra;
  }
  return kept.join("\n");
}

function mergeConversationSummary(previousSummary, chunkSummary) {
  const pieces = [];
  if (previousSummary) pieces.push(previousSummary.trim());
  if (chunkSummary) pieces.push(chunkSummary.trim());
  if (pieces.length === 0) return "";

  const merged = pieces.join("\n");
  return capSummaryByLines(merged, CONTEXT_SUMMARY_MAX_CHARS);
}

function estimatedContextTokens() {
  let chars = conversationSummary.length;
  for (const msg of conversationTranscript) {
    chars += String(msg.content || "").length;
  }
  return estimateTextTokens(chars);
}

function providerHistoryChars(providerName) {
  try {
    if (providerName === "Gemini") return JSON.stringify(geminiHistory).length;
    if (providerName === "OpenAI") return JSON.stringify(openaiHistory || []).length;
    if (providerName === "Claude") return JSON.stringify(claudeHistory).length;
    return 0;
  } catch {
    return PROVIDER_HISTORY_MAX_CHARS + 1;
  }
}

function injectSummaryForProvider(providerName) {
  if (!conversationSummary) return;

  const summaryText = `Contexto anterior compacto (nao e resposta do assistente, apenas memoria factual):\n${conversationSummary}`;

  if (providerName === "Gemini") {
    geminiHistory.push({ role: "user", parts: [{ text: summaryText }] });
  } else if (providerName === "OpenAI") {
    if (!openaiHistory) openaiHistory = [{ role: "system", content: getOpenAISystemPrompt() }];
    openaiHistory.push({ role: "user", content: summaryText });
  } else if (providerName === "Claude") {
    claudeHistory.push({ role: "user", content: summaryText });
  }
}

function rebuildProviderHistoriesFromContext() {
  geminiHistory = [];
  openaiHistory = [{ role: "system", content: getOpenAISystemPrompt() }];
  claudeHistory = [];

  seedProviderHistory("Gemini");
  seedProviderHistory("OpenAI");
  seedProviderHistory("Claude");
}

/**
 * Prune old tool outputs from provider histories to save context space.
 * Inspired by OpenCode's approach: keep recent 40K chars of tool outputs intact,
 * truncate older ones to a short preview. This prevents browser snapshots and
 * long command outputs from bloating the context.
 */
const TOOL_OUTPUT_RECENT_BUDGET_CHARS = 40_000;
const TOOL_OUTPUT_TRUNCATED_PREVIEW = 200;

function pruneProviderToolOutputs() {
  pruneGeminiToolOutputs();
  pruneOpenAIToolOutputs();
  pruneClaudeToolOutputs();
}

function pruneGeminiToolOutputs() {
  // Gemini: tool results are functionResponse parts in user messages
  let recentChars = 0;
  for (let i = geminiHistory.length - 1; i >= 0; i--) {
    const msg = geminiHistory[i];
    if (msg.role !== "user" || !Array.isArray(msg.parts)) continue;
    for (let j = msg.parts.length - 1; j >= 0; j--) {
      const part = msg.parts[j];
      if (!part.functionResponse?.response?.result) continue;
      const result = String(part.functionResponse.response.result);
      recentChars += result.length;
      if (recentChars > TOOL_OUTPUT_RECENT_BUDGET_CHARS && result.length > TOOL_OUTPUT_TRUNCATED_PREVIEW * 2) {
        part.functionResponse.response.result = result.slice(0, TOOL_OUTPUT_TRUNCATED_PREVIEW) + "\n...[output truncado para economizar contexto]";
      }
    }
  }
}

function pruneOpenAIToolOutputs() {
  if (!openaiHistory) return;
  let recentChars = 0;
  for (let i = openaiHistory.length - 1; i >= 0; i--) {
    const msg = openaiHistory[i];
    if (msg.role !== "tool" || typeof msg.content !== "string") continue;
    recentChars += msg.content.length;
    if (recentChars > TOOL_OUTPUT_RECENT_BUDGET_CHARS && msg.content.length > TOOL_OUTPUT_TRUNCATED_PREVIEW * 2) {
      msg.content = msg.content.slice(0, TOOL_OUTPUT_TRUNCATED_PREVIEW) + "\n...[output truncado para economizar contexto]";
    }
  }
}

function pruneClaudeToolOutputs() {
  let recentChars = 0;
  for (let i = claudeHistory.length - 1; i >= 0; i--) {
    const msg = claudeHistory[i];
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
    for (let j = msg.content.length - 1; j >= 0; j--) {
      const block = msg.content[j];
      if (block.type !== "tool_result" || typeof block.content !== "string") continue;
      recentChars += block.content.length;
      if (recentChars > TOOL_OUTPUT_RECENT_BUDGET_CHARS && block.content.length > TOOL_OUTPUT_TRUNCATED_PREVIEW * 2) {
        block.content = block.content.slice(0, TOOL_OUTPUT_TRUNCATED_PREVIEW) + "\n...[output truncado para economizar contexto]";
      }
    }
  }
}

function compactContextIfNeeded() {
  let compacted = false;
  let removedMessages = 0;

  while (
    conversationTranscript.length > CONTEXT_KEEP_RECENT_MESSAGES &&
    estimatedContextTokens() > CONTEXT_MAX_ESTIMATED_TOKENS
  ) {
    const removableCount = Math.max(1, conversationTranscript.length - CONTEXT_KEEP_RECENT_MESSAGES);
    const chunk = conversationTranscript.splice(0, removableCount);
    removedMessages += chunk.length;
    const chunkSummary = summarizeTranscriptChunk(chunk);
    conversationSummary = mergeConversationSummary(conversationSummary, chunkSummary);
    compacted = true;
  }

  // Safety valve for raw transcript count even if token estimate is low.
  if (conversationTranscript.length > CONTEXT_KEEP_RECENT_MESSAGES * 2) {
    const removableCount = conversationTranscript.length - CONTEXT_KEEP_RECENT_MESSAGES * 2;
    const chunk = conversationTranscript.splice(0, removableCount);
    removedMessages += chunk.length;
    const chunkSummary = summarizeTranscriptChunk(chunk);
    conversationSummary = mergeConversationSummary(conversationSummary, chunkSummary);
    compacted = true;
  }

  if (compacted) {
    rebuildProviderHistoriesFromContext();
    emitContextCompacted(removedMessages, conversationSummary.length);
    return;
  }

  // Prune old tool outputs in provider histories (browser snapshots, long command outputs).
  // This runs every turn regardless of compaction — keeps recent outputs intact, truncates old ones.
  pruneProviderToolOutputs();

  // Prune provider-specific histories if they grew too much (tool loops can bloat them).
  const shouldPruneProviderHistory =
    providerHistoryChars("Gemini") > PROVIDER_HISTORY_MAX_CHARS
    || providerHistoryChars("OpenAI") > PROVIDER_HISTORY_MAX_CHARS
    || providerHistoryChars("Claude") > PROVIDER_HISTORY_MAX_CHARS;

  if (shouldPruneProviderHistory) {
    rebuildProviderHistoriesFromContext();
    emitContextCompacted(0, conversationSummary.length);
  }
}

/**
 * Seed a provider's history with the conversation transcript (if empty).
 * Called before starting a provider loop when the provider has no history
 * but we have context from other providers' successful turns.
 */
function seedProviderHistory(providerName) {
  if (conversationTranscript.length === 0 && !conversationSummary) return;

  if (providerName === "Gemini" && geminiHistory.length === 0) {
    injectSummaryForProvider("Gemini");
    for (const m of conversationTranscript) {
      const role = m.role === "user" ? "user" : "model";
      geminiHistory.push({ role, parts: [{ text: m.content }] });
    }
  } else if (providerName === "OpenAI" && (!openaiHistory || openaiHistory.length <= 1)) {
    // openaiHistory[0] is the system message; only seed if no conversation yet
    if (!openaiHistory) openaiHistory = [{ role: "system", content: getOpenAISystemPrompt() }];
    injectSummaryForProvider("OpenAI");
    for (const m of conversationTranscript) {
      const role = m.role === "user" ? "user" : "assistant";
      openaiHistory.push({ role, content: m.content });
    }
  } else if (providerName === "Claude" && claudeHistory.length === 0) {
    injectSummaryForProvider("Claude");
    for (const m of conversationTranscript) {
      const role = m.role === "user" ? "user" : "assistant";
      claudeHistory.push({ role, content: m.content });
    }
  }
}

// Interrupt handling — allows cancelling the current LLM request
let currentAbortController = null;
let interruptRequested = false;

async function runGeminiLoop(userText, signal, modelId, imageInputs = []) {
  // Remember history length so we can roll back on error.
  // This prevents dangling user messages that break alternation requirements.
  const historyLenBefore = geminiHistory.length;
  const userParts = [];
  for (const img of imageInputs) {
    userParts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } });
  }
  userParts.push({ text: userText });
  geminiHistory.push({ role: "user", parts: userParts });
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
        const result = await runToolWithLifecycle(tc.name, tc.input);
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

function mimeFromImagePath(path) {
  const lower = String(path || "").toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "image/png";
}

async function loadImageInputs(imagePaths) {
  if (!Array.isArray(imagePaths) || imagePaths.length === 0) return [];
  const loaded = [];
  for (const p of imagePaths) {
    if (!p || typeof p !== "string") continue;
    try {
      const bytes = await readFile(p);
      const mimeType = mimeFromImagePath(p);
      const base64 = bytes.toString("base64");
      loaded.push({
        path: p,
        mimeType,
        base64,
        dataUrl: `data:${mimeType};base64,${base64}`,
      });
    } catch (err) {
      process.stderr.write(`Falha ao carregar imagem ${p}: ${err.message}\n`);
    }
  }
  return loaded;
}

function parseCodexOutput(data) {
  let text = "";
  const toolCalls = [];
  if (data?.output && Array.isArray(data.output)) {
    for (const item of data.output) {
      if (item.type === "message" && item.content) {
        for (const part of item.content) {
          if (part.type === "output_text") {
            text += part.text || "";
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
  return { text, toolCalls };
}

async function parseCodexStreamResponse(res, signal) {
  const reader = res.body?.getReader();
  if (!reader) {
    throw new Error("OpenAI Codex stream sem body de resposta");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let streamedText = "";
  const toolCallsById = new Map();
  let completedResponse = null;

  while (true) {
    if (signal?.aborted || interruptRequested) {
      throw new Error("Interrupted");
    }
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      const lines = rawEvent.split("\n");
      let dataText = "";
      for (const line of lines) {
        if (line.startsWith("data:")) {
          dataText += line.slice(5).trimStart();
        }
      }
      if (!dataText || dataText === "[DONE]") continue;

      let event;
      try {
        event = JSON.parse(dataText);
      } catch {
        continue;
      }

      if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
        streamedText += event.delta;
      }

      if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
        const item = event.item;
        toolCallsById.set(item.call_id, {
          name: item.name,
          input: (() => { try { return JSON.parse(item.arguments); } catch { return {}; } })(),
          callId: item.call_id,
        });
      }

      if (event.type === "response.completed" && event.response) {
        completedResponse = event.response;
      }

      if (event.type === "response.failed") {
        const message = event.response?.error?.message || event.error?.message || "OpenAI Codex stream failed";
        throw new Error(message);
      }
    }
  }

  const parsedCompleted = parseCodexOutput(completedResponse || {});
  const text = streamedText || parsedCompleted.text;
  const toolCalls = toolCallsById.size > 0
    ? Array.from(toolCallsById.values())
    : parsedCompleted.toolCalls;

  return { text, toolCalls };
}

async function runOpenAILoop(userText, signal, imageInputs = []) {
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
    return runOpenAICodexLoop(userText, oauthToken, signal, imageInputs);
  }

  // Standard API key mode — Chat Completions API
  const authHeader = `Bearer ${token}`;
  const openaiTools = toolDeclarations.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

    if (!openaiHistory) {
      openaiHistory = [{ role: "system", content: getOpenAISystemPrompt() }];
    }
  // Remember history length so we can roll back on error
  const historyLenBefore = openaiHistory.length;
  openaiHistory.push({ role: "user", content: userText });
  let messages = openaiHistory;

  const visionContent = imageInputs.length > 0
    ? [
        { type: "text", text: userText },
        ...imageInputs.map((img) => ({ type: "image_url", image_url: { url: img.dataUrl } })),
      ]
    : null;

  try {
    let firstRequest = true;
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

      const requestMessages = (firstRequest && visionContent)
        ? [...messages.slice(0, -1), { role: "user", content: visionContent }]
        : messages;

      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        signal: combinedSignal,
        headers: {
          "Content-Type": "application/json",
          Authorization: authHeader,
          ...(process.env.OPENAI_ACCOUNT_ID ? { "OpenAI-Organization": process.env.OPENAI_ACCOUNT_ID } : {}),
        },
        body: JSON.stringify({ model: "gpt-5.3-codex", messages: requestMessages, tools: openaiTools }),
      });
      firstRequest = false;

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
        const result = await runToolWithLifecycle(tc.name, tc.input);
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
async function runOpenAICodexLoop(userText, oauthToken, signal, imageInputs = []) {
  const accountId = process.env.OPENAI_ACCOUNT_ID || "";

  // Build Responses API input format
  const input = [];
  // Add system prompt as developer instructions (Responses API uses top-level `instructions`)
  // Add conversation history from transcript if we have prior context
    if (!openaiHistory) {
      openaiHistory = [{ role: "system", content: getOpenAISystemPrompt() }];
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

  const visionBlocks = imageInputs.map((img) => ({ type: "input_image", image_url: img.dataUrl }));

  try {
    let firstRequest = true;
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

      const requestInput = (firstRequest && visionBlocks.length > 0)
        ? [
            ...input.slice(0, -1),
            {
              role: "user",
              content: [{ type: "input_text", text: userText }, ...visionBlocks],
            },
          ]
        : input;

      const body = {
        model: "gpt-5.3-codex",
        instructions: getOpenAICodexInstructions(),
        input: requestInput,
        tools: responsesTools,
        store: false,
        stream: true,
      };
      firstRequest = false;

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

      const { text, toolCalls } = await parseCodexStreamResponse(res, signal);

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
        const result = await runToolWithLifecycle(tc.name, tc.input);

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

async function runClaudeLoop(userText, signal, imageInputs = []) {
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
  if (imageInputs.length > 0) {
    const content = [
      ...imageInputs.map((img) => ({
        type: "image",
        source: {
          type: "base64",
          media_type: img.mimeType,
          data: img.base64,
        },
      })),
      { type: "text", text: userText },
    ];
    claudeHistory.push({ role: "user", content });
  } else {
    claudeHistory.push({ role: "user", content: userText });
  }
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

      const systemPrompt = getClaudeSystemPrompt(useOAuth);

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
        const result = await runToolWithLifecycle(tb.name, tb.input);
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
    await refreshSystemPromptCache();
    for (const m of msg.messages) {
      const role = m.role === "user" ? "user" : "model";
      if (hasGemini()) {
        geminiHistory.push({ role, parts: [{ text: m.content }] });
      }
      if (hasOpenAI() || hasClaude()) {
        const oaRole = m.role === "user" ? "user" : "assistant";
        if (hasOpenAI()) {
          if (!openaiHistory) openaiHistory = [{ role: "system", content: getOpenAISystemPrompt() }];
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
    compactContextIfNeeded();
    emit({ type: "history_loaded", count: msg.messages.length });
    return;
  }

  if (msg.type !== "message" || !msg.text) return;

  const userText = msg.text;
  await refreshSystemPromptCache();
  const requestedMode = String(msg.mode || "build").toLowerCase() === "plan" ? "plan" : "build";
  const parsedPolicy = parseTurnPolicy(userText);
  currentTurnPolicy = {
    ...parsedPolicy,
    executionMode: requestedMode,
    executionRequired: requestedMode === "plan" ? false : parsedPolicy.executionRequired,
    expectedActions: requestedMode === "plan"
      ? { gitPull: false, gitCommit: false, gitPush: false }
      : parsedPolicy.expectedActions,
    planningOnly: requestedMode === "plan" ? true : parsedPolicy.planningOnly,
  };
  currentTurnStats = {
    phase: "planning",
    toolCalls: 0,
    toolNames: new Set(),
    changedPaths: new Set(),
    commands: [],
    validations: [],
    executionTrail: [],
    browserScrolled: false,
    browserAtBottom: false,
    toolErrors: 0,
    executedToolCalls: 0,
    blockedByPolicyReason: "",
    completedActions: { gitPull: false, gitCommit: false, gitPush: false },
    lastToolFingerprint: "",
    repeatedToolCount: 0,
    maxStepsReached: false,
  };
  const continuation = isContinuationRequest(userText) && !!pendingContinuation;
  const baseTurnTaskText = continuation ? buildContinuationPrompt(userText) : userText;
  const turnTaskText = currentTurnPolicy.planningOnly
    ? buildPlanningOnlyPrompt(baseTurnTaskText)
    : baseTurnTaskText;
  if (continuation) {
    emitStatus("Retomando tarefa pendente da rodada anterior...");
  }
  if (!continuation && !isContinuationRequest(userText)) {
    pendingContinuation = null;
  }
  const imageInputs = await loadImageInputs(msg.images);
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

  // Keep context/history bounded before selecting provider cascade.
  compactContextIfNeeded();

  // Check if superseded after token refresh
  if (isSuperseded()) {
    currentAbortController = null;
    currentTurnStats = null;
    currentTurnPolicy = { allowCommit: false, allowPush: false, allowPr: false, executionRequired: false, expectedActions: { gitPull: false, gitCommit: false, gitPush: false }, planningOnly: false, executionMode: "build" };
    pendingContinuation = null;
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
        fn: (text, sig, imgs) => runClaudeLoop(text, sig, imgs),
      });
    } else if (model.id === "gpt-5.3-codex") {
      cascade.push({
        modelId: model.id,
        name: model.label,
        seedName: "OpenAI",
        fn: (text, sig, imgs) => runOpenAILoop(text, sig, imgs),
      });
    } else if (model.id === "gemini-3.1-pro") {
      cascade.push({
        modelId: model.id,
        name: model.label,
        seedName: "Gemini",
        fn: (text, sig, imgs) => runGeminiLoop(text, sig, "gemini-3.1-pro", imgs),
      });
    } else if (model.id === "gemini-3.0-flash") {
      cascade.push({
        modelId: model.id,
        name: model.label,
        seedName: "Gemini",
        fn: (text, sig, imgs) => runGeminiLoop(text, sig, "gemini-3.0-flash", imgs),
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
  let maxStepsTriggered = false;
  for (let providerIndex = 0; providerIndex < cascade.length; providerIndex++) {
    const provider = cascade[providerIndex];
    const providerTaskText = providerIndex > 0 ? buildFallbackCarryoverContext(turnTaskText) : turnTaskText;
    if (providerIndex > 0 && currentTurnStats) {
      // Avoid false loop detection when the next provider repeats the latest probe command.
      currentTurnStats.lastToolFingerprint = "";
      currentTurnStats.repeatedToolCount = 0;
      if (currentTurnStats.executedToolCalls > 0) {
        emitStatus(`Retomando no ${provider.name} com contexto de execucao da rodada...`);
      }
    }
    // Seed provider history with transcript from other providers (prevents amnesia on cascade switch)
    seedProviderHistory(provider.seedName);

    let attempts = 0;
    let authRetried = false; // auth refresh retry is separate from timeout retries
    const maxAttempts = 1 + MAX_TIMEOUT_RETRIES; // 1 initial + N timeout retries
    let forcedExecutionRetried = false;
    while (attempts < maxAttempts) {
      attempts++;
      try {
        emitModelActive(provider.modelId, provider.name);
        result = await provider.fn(providerTaskText, signal, imageInputs);

        const shouldRunForcedExecutionPass =
          currentTurnPolicy.executionMode === "build"
          && currentTurnPolicy.executionRequired
          && !forcedExecutionRetried
          && !currentTurnStats?.maxStepsReached
          && (currentTurnStats?.executedToolCalls ?? 0) === 0;

        if (shouldRunForcedExecutionPass || (shouldForceExecutionRetry(providerTaskText, result) && !forcedExecutionRetried)) {
          forcedExecutionRetried = true;
          result = await provider.fn(buildForcedExecutionPrompt(providerTaskText), signal, imageInputs);
        }

        lastErr = null;
        break;
      } catch (err) {
        if (isMaxStepsError(err)) {
          maxStepsTriggered = true;
          emitProviderError(MAX_STEPS_MESSAGE);
          result = "";
          lastErr = null;
          break;
        }

        // Check if this was an interrupt (not a provider failure)
        if (err.message === "Interrupted" || signal.aborted || interruptRequested) {
          // Interrupted by user — emit waiting_user so UI shows compose bar
          currentAbortController = null;
          // Only emit if this is still the latest generation
          if (!isSuperseded()) {
            emitWaitingUser();
          }
          currentTurnStats = null;
          currentTurnPolicy = { allowCommit: false, allowPush: false, allowPr: false, executionRequired: false, expectedActions: { gitPull: false, gitCommit: false, gitPush: false }, planningOnly: false, executionMode: "build" };
          pendingContinuation = null;
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
          emitProviderRetry(provider.name, "timeout");
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
          emitProviderRetry(provider.name, "auth");
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
    if (!lastErr) {
      if (providerIndex > 0) {
        emitFallbackUsed(provider.name, providerIndex);
      }
      break; // Success — stop cascade
    }
  }

  currentAbortController = null;

  // Check if superseded before emitting response
  if (isSuperseded()) {
    currentTurnStats = null;
    currentTurnPolicy = { allowCommit: false, allowPush: false, allowPr: false, executionRequired: false, expectedActions: { gitPull: false, gitCommit: false, gitPush: false }, planningOnly: false, executionMode: "build" };
    pendingContinuation = null;
    return;
  }

  if (lastErr) {
    emitError(lastErr.message || "Erro desconhecido no sub-agente.");
    currentTurnStats = null;
    currentTurnPolicy = { allowCommit: false, allowPush: false, allowPr: false, executionRequired: false, expectedActions: { gitPull: false, gitCommit: false, gitPush: false }, planningOnly: false, executionMode: "build" };
    pendingContinuation = null;
  } else {
    currentTurnStats.phase = "reporting";

    if (
      currentTurnPolicy.executionMode !== "plan"
      && !currentTurnPolicy.planningOnly
      &&
      !currentTurnStats?.maxStepsReached
      && (currentTurnStats?.executedToolCalls ?? 0) === 0
      && looksLikeTechnicalActionRequest(turnTaskText)
      && !looksLikePlanDraftRequest(turnTaskText)
      && looksLikeTechnicalCompletion(result)
      && !acknowledgesPriorExecution(result)
    ) {
      const guarded = buildNoExecutionGuardMessage();
      result = guarded;
    }

    if (
      currentTurnPolicy.executionMode === "build"
      && currentTurnPolicy.executionRequired
      && !currentTurnStats?.maxStepsReached
      && (currentTurnStats?.executedToolCalls ?? 0) === 0
      && !looksLikePlanDraftRequest(turnTaskText)
    ) {
      if (currentTurnStats?.blockedByPolicyReason) {
        result = `Nao executei as acoes tecnicas porque o comando foi bloqueado por politica antes da execucao: ${currentTurnStats.blockedByPolicyReason}`;
      } else {
        result = "Falha operacional: esta rodada exigia execucao, mas o modelo encerrou sem chamar ferramentas. Nenhuma alteracao foi aplicada.";
      }
    }

    if (
      currentTurnPolicy.executionMode === "build"
      && currentTurnPolicy.executionRequired
      && !currentTurnStats?.maxStepsReached
      && (currentTurnStats?.executedToolCalls ?? 0) > 0
      && !looksLikePlanDraftRequest(turnTaskText)
    ) {
      const missing = missingExpectedActions();
      if (missing.length > 0) {
        result = `Falha operacional: esta rodada exigia execucao de ${missing.join(", ")}, mas essas acoes nao foram executadas. Nenhuma conclusao tecnica foi assumida.`;
      }
    }

    const shouldAppendReceipt =
      currentTurnPolicy.executionMode !== "plan"
      && !currentTurnStats?.maxStepsReached
      && looksLikeTechnicalActionRequest(turnTaskText)
      && (currentTurnStats?.executedToolCalls ?? 0) > 0
      && !hasExecutionReceipt(result);

    if (shouldAppendReceipt) {
      result = `${String(result || "").trim()}${buildExecutionReceipt()}`.trim();
    }

    if (
      currentTurnPolicy.executionMode === "build"
      && looksLikeFakeAccessBlockClaim(result)
      && (currentTurnStats?.toolErrors ?? 0) === 0
      && (currentTurnStats?.executedToolCalls ?? 0) === 0
    ) {
      result = "Ainda nao tentei executar ferramentas suficientes nesta rodada para concluir que existe bloqueio real de acesso. Posso executar agora os passos tecnicos e te trazer evidencias objetivas.";
      emitProviderError("Guardrail de bloqueio: resposta ajustada para evitar alegacao de falta de acesso sem erro real de ferramenta.");
    }

    // Record successful turn in provider-agnostic transcript (for cascade seeding)
    conversationTranscript.push({ role: "user", content: turnTaskText });
    if (result && result !== FALLBACK_RESULT) {
      conversationTranscript.push({ role: "assistant", content: result });
    }
    compactContextIfNeeded();
    if (currentTurnStats?.maxStepsReached) {
      snapshotPendingContinuation(userText);
    } else {
      pendingContinuation = null;
    }
    // Signal that we're done processing this turn but ready for more input.
    // The session stays alive — the host will show the compose bar again.
    emitWaitingUser(maxStepsTriggered ? undefined : result);
    currentTurnStats = null;
    currentTurnPolicy = { allowCommit: false, allowPush: false, allowPr: false, executionRequired: false, expectedActions: { gitPull: false, gitCommit: false, gitPush: false }, planningOnly: false, executionMode: "build" };
  }
});

rl.on("close", () => {
  process.exit(0);
});
