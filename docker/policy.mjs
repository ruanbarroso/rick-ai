/**
 * policy.mjs — Turn policy detection, text heuristics, and prompt builders.
 *
 * Pure functions for analyzing user text and building policy-driven prompts.
 * No module-level state — all state is passed as parameters.
 */

// ── Text heuristics ─────────────────────────────────────────────────────────

export function looksLikeTechnicalCompletion(text) {
  const normalized = String(text || "").toLowerCase();
  return /(corrigi|ajustei|removi|alterei|refatorei|implementei|adicionei|criei|resolvi|conclui|finalizei|feito|aplicad|deploy|commit)/.test(normalized);
}

export function looksLikeTechnicalActionRequest(text) {
  const normalized = String(text || "").toLowerCase();
  return /(commit|push|pull request|pr\b|git|corrig|ajust|remov|alter|refator|implemen|adicion|cria|bug|erro|teste|build|codigo|code|arquivo|repo|reposit|execute|executa|executar|aplica|aplicar|fa[çc]a|\bfaz\b|\bfazer\b)/.test(normalized);
}

export function looksLikeExecutionNowRequest(text) {
  const normalized = String(text || "").toLowerCase();
  return /(execute|executa|executar|pode executar|agora|manda ver|aplica|aplicar|fa[çc]a|segue com a implementa|pode seguir)/.test(normalized);
}

export function looksLikeConcreteExecutionRequest(text) {
  const normalized = String(text || "").toLowerCase();
  return /(execute|executa|executar|aplica|aplicar|implement|corrig|ajust|alter|remov|refator|rode|rodar|roda|fa[çc]a|\bfaz\b|\bfazer\b|git\s+pull|git\s+commit|git\s+push|checkout|clone|clona|cria\s+pr|abre\s+pr)/.test(normalized);
}

export function looksLikeExecutionPromise(text) {
  const normalized = String(text || "").toLowerCase();
  return /(vou executar|vou aplicar|vou implementar|posso executar|fechado[\s\S]{0,20}execut|entendi[\s\S]{0,30}execut|se voc[eê] confirma|se confirmar|assim que confirmar)/.test(normalized);
}

export function looksLikeExecutionClaim(text) {
  const normalized = String(text || "").toLowerCase();
  return /(conclu[ií]d|feito|aplicad|implementei|ajustei|corrigi|executei|push realizado|commit realizado|ja subi|j[aá] est[aá] no remoto|resultado final|o que eu fiz)/.test(normalized)
    || looksLikeExecutionPromise(normalized)
    || looksLikeTechnicalCompletion(normalized);
}

export function looksLikePlanDraftRequest(text) {
  const normalized = String(text || "").toLowerCase();
  const asksPlan = /(plano|planejamento|estrategia|estratégia|roadmap|passo a passo|proposta|como faria|o que faria|montar um plano)/.test(normalized);
  const asksExecutionNow = looksLikeExecutionNowRequest(normalized);
  return asksPlan && !asksExecutionNow;
}

export function looksLikeFakeAccessBlockClaim(text) {
  const normalized = String(text || "").toLowerCase();
  return /(nao tenho acesso|não tenho acesso|nao tenho execucao ativa|não tenho execução ativa|nao consigo executar ferramentas|não consigo executar ferramentas|bloqueado por acesso|iframe n[aã]o ficou acess[ií]vel|n[aã]o apareceu no snapshot|bloqueio real|componente interno sem elementos|n[aã]o exp[oõ]e.*elementos|iframe.*n[aã]o.*acess|shadow.*dom.*bloqu|conte[uú]do.*n[aã]o.*vis[ií]vel.*iframe|n[aã]o.*consegui.*acessar.*iframe)/.test(normalized);
}

export function looksLikeNoExecutionCapabilityClaim(text) {
  const normalized = String(text || "").toLowerCase();
  return /(nao tenho execucao ativa|não tenho execução ativa|nao consigo executar ferramentas|não consigo executar ferramentas|nao consigo chamar a api daqui|não consigo chamar a api daqui|sem sess[aã]o de navegador ativa|n[aã]o tenho acesso operacional [aà]s ferramentas|n[aã]o tenho acesso direto ao endpoint)/.test(normalized);
}

export function looksLikeCheckpointPause(text) {
  const normalized = String(text || "").toLowerCase();
  return /(se voc[eê] quiser.*continu|quer que eu (continu|prossig|siga|execut)|devo (continuar|prosseguir|seguir)|posso (continuar|prosseguir|seguir)|deseja que eu (continu|prossig|execut)|gostaria que eu (continu|prossig)|me avise se (quer|deseja|devo)|aguardo sua confirma[cç][aã]o para (continu|prosseg|execut)|caso queira.*continu|s[oó] me (diga|fala|avisa).*continu|quando (quiser|desejar).*continu)/.test(normalized);
}

export function acknowledgesPriorExecution(text) {
  const normalized = String(text || "").toLowerCase();
  return /(ja foi|já foi|etapa anterior|anteriormente|nesta conversa|como eu disse|sem alteracoes pendentes|sem alterações pendentes|nao executei|não executei)/.test(normalized);
}

export function isContinuationRequest(text) {
  const normalized = String(text || "").trim().toLowerCase();
  return /^(continua|continue|continuar|segue|prossegue|pode continuar|continue de onde parou|retoma|retomar)[.!?\s]*$/.test(normalized);
}

export function requestedFullHistory(text) {
  const normalized = String(text || "").toLowerCase();
  return /(todas as mensagens|historico completo|histórico completo|ler tudo|100% das mensagens|tudo da sessao|tudo da sessão)/.test(normalized);
}

export function looksLikeFullCoverageClaim(text) {
  const normalized = String(text || "").toLowerCase();
  return /(li todas as mensagens|todas as mensagens|historico completo|histórico completo|100%|li tudo)/.test(normalized);
}

export function hasExecutionReceipt(text) {
  const normalized = String(text || "").toLowerCase();
  return /(evidencias de execucao|evidências de execução|arquivos alterados|comandos executados|validacoes executadas|validações executadas)/.test(normalized);
}

// ── Command analysis ────────────────────────────────────────────────────────

export function summarizeCommandInput(input) {
  if (!input || typeof input !== "object") return "";
  if (typeof input.commandLine === "string" && input.commandLine.trim()) {
    return input.commandLine.trim().toLowerCase();
  }
  const cmd = typeof input.command === "string" ? input.command : "";
  const args = Array.isArray(input.args) ? input.args.map((a) => String(a)) : [];
  return `${cmd} ${args.join(" ")}`.trim().toLowerCase();
}

/**
 * Detect commands blocked by policy.
 * @param {string} toolName
 * @param {object} input
 * @param {object} policy — current turn policy { allowCommit, allowPush, allowPr }
 * @returns {string|null} block reason or null
 */
export function detectBlockedCommand(toolName, input, policy) {
  if (toolName !== "run_command") return null;
  const commandText = summarizeCommandInput(input);
  if (!commandText) return null;

  if (/\bgh\s+pr\s+create\b/.test(commandText) && !policy.allowPr) {
    return "Bloqueado por politica antes da execucao: so posso criar PR quando voce pedir explicitamente neste turno.";
  }
  if (/\bgit\s+push\b/.test(commandText) && !policy.allowPush) {
    return "Bloqueado por politica antes da execucao: so posso fazer git push quando voce pedir explicitamente neste turno.";
  }
  if (/\bgit\s+commit\b/.test(commandText) && !policy.allowCommit) {
    return "Bloqueado por politica antes da execucao: so posso fazer git commit quando voce pedir explicitamente neste turno.";
  }

  if (/(^|\s)rg(\s|$)/.test(commandText)) {
    return "Comando bloqueado: `rg` (ripgrep) nao esta disponivel neste ambiente. Use a ferramenta `grep` para busca de conteudo e `glob` para localizar arquivos.";
  }

  // Block bare `env` without filter — wastes tokens and risks leaking secrets.
  if (/^env\s*$/.test(commandText) || /^(\/usr\/bin\/)?env\s*$/.test(commandText)) {
    return "Comando bloqueado: `env` sem filtro despeja todas as variaveis de ambiente (desperdicio de tokens e risco de seguranca). Use `env | grep RICK_` ou `echo $NOME_VARIAVEL` para verificar variaveis especificas.";
  }

  return null;
}

export function detectPlanningOnlyToolBlock(toolName, policy) {
  if (!policy?.planningOnly) return null;
  return `Bloqueado por politica desta rodada: pedido de planejamento. Ferramenta ${toolName} nao deve ser executada.`;
}

// ── Turn policy parsing ─────────────────────────────────────────────────────

/**
 * Parse user text to determine turn policy flags.
 * @param {string} text
 * @param {object} recentGitPolicy — carried-over git policy from recent turns
 * @returns {{ allowCommit, allowPush, allowPr, executionRequired, technicalRequest, expectedActions, planningOnly, executionMode, updatedGitPolicy }}
 */
export function parseTurnPolicy(text, recentGitPolicy) {
  const normalized = String(text || "").toLowerCase();
  const explicitAllowCommit = /(\bcommit\b|\bcommitar\b)/.test(normalized);
  const explicitAllowPush = /(\bpush\b|\benviar para o remoto\b|\bsubir para o remoto\b)/.test(normalized);
  const explicitAllowPr = /(\bpull request\b|\babrir pr\b|\bcriar pr\b|\bgh pr\b)/.test(normalized);

  const hasExplicitGitIntent = explicitAllowCommit || explicitAllowPush || explicitAllowPr;
  let updatedGitPolicy = recentGitPolicy;
  if (hasExplicitGitIntent) {
    updatedGitPolicy = {
      allowCommit: explicitAllowCommit,
      allowPush: explicitAllowPush,
      allowPr: explicitAllowPr,
      expiresAt: Date.now() + 10 * 60_000,
    };
  }

  const inheritRecentGitPolicy = !hasExplicitGitIntent
    && looksLikeExecutionNowRequest(normalized)
    && recentGitPolicy.expiresAt > Date.now();

  const allowCommit = explicitAllowCommit || (inheritRecentGitPolicy && recentGitPolicy.allowCommit);
  const allowPush = explicitAllowPush || (inheritRecentGitPolicy && recentGitPolicy.allowPush);
  const allowPr = explicitAllowPr || (inheritRecentGitPolicy && recentGitPolicy.allowPr);
  const technicalRequest = looksLikeTechnicalActionRequest(normalized);
  const executionRequired = !looksLikePlanDraftRequest(normalized) && looksLikeConcreteExecutionRequest(normalized);
  const expectedActions = {
    gitPull: /\bgit\s+pull\b|\bpull\s+--rebase\b/.test(normalized),
    gitCommit: /\bgit\s+commit\b|\bcommit\b|\bcommitar\b/.test(normalized),
    gitPush: /\bgit\s+push\b|\bpush\b|\benviar para o remoto\b|\bsubir para o remoto\b/.test(normalized),
  };
  return { allowCommit, allowPush, allowPr, executionRequired, technicalRequest, expectedActions, planningOnly: false, executionMode: "build", updatedGitPolicy };
}

export function missingExpectedActions(policy, stats) {
  if (!policy?.expectedActions || !stats?.completedActions) return [];
  const missing = [];
  if (policy.expectedActions.gitPull && !stats.completedActions.gitPull) missing.push("git pull");
  if (policy.expectedActions.gitCommit && !stats.completedActions.gitCommit) missing.push("git commit");
  if (policy.expectedActions.gitPush && !stats.completedActions.gitPush) missing.push("git push");
  return missing;
}

// ── Prompt builders ─────────────────────────────────────────────────────────

export function buildPlanningOnlyPrompt(userText) {
  return `${userText}\n\n[MODO_PLANEJAMENTO]\nResponda APENAS com plano/estrategia. Nao execute ferramentas nesta rodada e nao alegue execucao.`;
}

export function buildForcedExecutionPrompt(baseTaskText) {
  return `${baseTaskText}\n\n[EXECUCAO_OBRIGATORIA]\nEsta rodada esta em modo BUILD e o usuario pediu execucao agora. Nao responda com promessa, confirmacao ou deferimento. Execute ferramentas imediatamente e so entregue resposta final apos tentar os passos tecnicos.`;
}

export function buildContinuationPrompt(userText, pendingContinuation) {
  if (!pendingContinuation) return userText;
  const context = [
    "Retome EXATAMENTE a tarefa que ficou pendente na rodada anterior.",
    `Tarefa original pendente: ${pendingContinuation.userText}`,
    pendingContinuation.evidence || "",
    "Nao reinicie do zero. Continue do ponto onde parou.",
  ].filter(Boolean).join("\n");
  return `${userText}\n\n[CONTEXTO_DE_CONTINUACAO]\n${context}`;
}

export function buildNoExecutionGuardMessage() {
  return "Ainda nao executei nenhuma ferramenta nesta rodada, entao nao vou afirmar conclusao tecnica. Posso continuar agora executando os passos no repositorio e te trazer evidencias objetivas.";
}

export function shouldForceExecutionRetry(taskText, resultText, policy, stats) {
  if (policy.executionMode !== "build") return false;
  if (policy.planningOnly) return false;
  if (!policy.executionRequired) return false;
  if (stats?.maxStepsReached) return false;
  if ((stats?.executedToolCalls ?? 0) > 0) return false;

  const requestedExecution = looksLikeTechnicalActionRequest(taskText) || looksLikeExecutionNowRequest(taskText);
  if (!requestedExecution) return false;

  return looksLikeExecutionPromise(resultText);
}

export function shouldSuppressInterimClaim(text, policy, stats) {
  if (!policy?.technicalRequest) return false;
  if (policy.executionMode !== "build") return false;
  if (policy.planningOnly) return false;
  if (!stats) return false;
  const normalized = String(text || "").toLowerCase();
  if (looksLikeNoExecutionCapabilityClaim(normalized) && (stats.executedToolCalls ?? 0) > 0) {
    return true;
  }
  return looksLikeExecutionPromise(normalized)
    || (looksLikeExecutionClaim(normalized) && (stats.executedToolCalls ?? 0) === 0);
}

/**
 * Detect checkpoint pauses where the model stops mid-task to ask for
 * permission to continue. These should be stripped in build mode so
 * the model keeps executing instead of waiting.
 */
export function shouldStripCheckpointPause(text, policy) {
  if (!policy) return false;
  if (policy.executionMode !== "build") return false;
  if (policy.planningOnly) return false;
  return looksLikeCheckpointPause(text);
}

/**
 * Remove checkpoint pause phrases from model output text.
 * Returns cleaned text or original if no match.
 */
export function stripCheckpointPhrases(text) {
  if (!text) return text;
  let cleaned = String(text);
  const patterns = [
    /se\s+voc[eê]\s+quiser[^\n.!?]*(?:continu|prossig|seguir|execut)[^\n.!?]*[.!?]?/gi,
    /quer\s+que\s+eu\s+(?:continu|prossig|siga|execut)[^\n.!?]*[.!?]?/gi,
    /devo\s+(?:continuar|prosseguir|seguir)[^\n.!?]*[.!?]?/gi,
    /posso\s+(?:continuar|prosseguir|seguir)[^\n.!?]*[.!?]?/gi,
    /deseja\s+que\s+eu\s+(?:continu|prossig|execut)[^\n.!?]*[.!?]?/gi,
    /me\s+avise\s+se\s+(?:quer|deseja|devo)[^\n.!?]*[.!?]?/gi,
    /aguardo\s+sua\s+confirma[cç][aã]o\s+para\s+(?:continu|prosseg|execut)[^\n.!?]*[.!?]?/gi,
  ];
  for (const pattern of patterns) {
    cleaned = cleaned.replace(pattern, " ");
  }
  cleaned = cleaned
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  const result = cleaned;
  // If stripping removed everything, return original (don't produce empty)
  return result.length > 0 ? result : text;
}
