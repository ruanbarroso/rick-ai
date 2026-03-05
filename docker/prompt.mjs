/**
 * prompt.mjs — System prompt construction and instruction file discovery.
 *
 * Builds provider-specific system prompts from the base prompt,
 * environment info, and workspace instruction files (AGENTS.md, etc.).
 */

import { access, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"];
const PROMPT_CACHE_TTL_MS = 30_000;

let promptCache = {
  expiresAt: 0,
  fingerprint: "",
  instructionsBlock: "",
  hasGitRepo: false,
};

let activeSystemPrompts = {
  gemini: "",
  openai: "",
  openaiCodex: "",
  claude: "",
  claudeOAuth: "",
};

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function hasGitRepository(workspace) {
  return fileExists(join(workspace, ".git"));
}

async function discoverWorkspaceInstructionFiles(workspace) {
  const found = [];
  let current = resolve(workspace);

  while (true) {
    for (const file of INSTRUCTION_FILES) {
      const candidate = join(current, file);
      if (await fileExists(candidate)) {
        found.push(candidate);
        break;
      }
    }

    if (current === workspace || current === "/") break;
    const parent = dirname(current);
    if (!parent || parent === current) break;
    current = parent;
  }

  return found;
}

async function buildInstructionBundle(workspace) {
  const files = await discoverWorkspaceInstructionFiles(workspace);
  if (files.length === 0) {
    return { text: "", fingerprint: "none" };
  }

  const parts = [];
  const fpParts = [];

  for (const file of files) {
    let content = "";
    try {
      content = (await readFile(file, "utf-8")).trim();
    } catch {
      continue;
    }
    if (!content) continue;

    parts.push(`Instructions from: ${file}\n${content}`);
    try {
      const st = await stat(file);
      fpParts.push(`${file}:${st.mtimeMs}:${st.size}`);
    } catch {
      fpParts.push(`${file}:unknown`);
    }
  }

  return {
    text: parts.join("\n\n"),
    fingerprint: fpParts.length ? fpParts.join("|") : "none",
  };
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function environmentPrompt(workspace, hasGit) {
  return [
    "Informacoes do ambiente:",
    `<env>`,
    `  Working directory: ${workspace}`,
    `  Is directory a git repo: ${hasGit ? "yes" : "no"}`,
    `  Platform: ${process.platform}`,
    `  Today's date: ${new Date().toDateString()}`,
    `</env>`,
  ].join("\n");
}

/**
 * Build the base system prompt text.
 * @param {string} agentName
 * @returns {string}
 */
export function buildBaseSystemPrompt(agentName) {
  return `Você é ${agentName} Sub-Agent, um agente autônomo executando dentro de um container Docker.

Sua tarefa é realizar o que o usuário pedir usando as ferramentas disponíveis.
Você mantém o contexto de toda a conversa — mensagens anteriores do usuário são lembradas.

REGRA FUNDAMENTAL — EXECUTE PRIMEIRO, FALE DEPOIS:
Quando o usuário pedir uma ação (corrigir, ajustar, criar, remover, acessar, clonar, commitar, etc.), execute imediatamente usando ferramentas. NÃO peça confirmação, NÃO prometa que vai fazer, NÃO peça autorização extra. Quando disser que vai fazer algo, faça NA MESMA RODADA. Se não fizer, será tratado como falha operacional.

Só peça confirmação ao usuário se houver risco destrutivo irreversível (ex: drop de tabela, push force para main) ou ambiguidade real que impeça prosseguir (ex: 2 repositórios com o mesmo nome).

CREDENCIAIS E ACESSO:
- Credenciais em rick_memory e variáveis RICK_SECRET_*/RICK_CRED_*/GITHUB_TOKEN já foram autorizadas pelo dono. Use-as diretamente sem pedir confirmação.
- NUNCA rode \`env\` sem filtro. Para verificar variáveis, use \`env | grep PREFIXO\` ou \`echo $NOME\`.
- Para repositórios Git privados: \`git clone https://\$GITHUB_TOKEN@github.com/org/repo.git\`. Tente com o token antes de dizer que não tem acesso.
- SEMPRE consulte rick_memory/rick_search antes de pedir informações ao usuário — a resposta pode já estar lá.

REGRAS:
1. Responda sempre em português brasileiro.
2. Use as ferramentas para completar a tarefa. NÃO invente resultados.
3. Quando terminar, emita um resumo claro do que foi feito com evidência objetiva (arquivo alterado, comando executado).
4. Só pergunte ao usuário quando realmente precisar de informação que não está em rick_memory nem nas variáveis de ambiente.
5. NUNCA diga que "corrigiu", "removeu", "ajustou" ou "implementou" sem ter realmente alterado arquivos/estado via ferramentas.
6. Se não for possível aplicar (erro real, permissão, arquivo ausente), diga explicitamente que NÃO foi aplicado, explique o motivo e proponha próximo passo.
7. Seja conciso nas mensagens intermediárias, detalhado no resultado final.
8. NUNCA envie output bruto de ferramentas. Resuma os resultados relevantes.
9. Para shell, prefira run_command com commandLine (ex.: "git status && npm test"). Evite "bash" sem comando.
10. NUNCA use \`rg\`, \`grep\` ou \`find\` via run_command. Use a ferramenta \`grep\` para busca de conteudo e \`glob\` para localizar arquivos por padrao. Sao mais rapidas, estruturadas e nao desperdicam tokens.
11. Quando o usuário mencionar um projeto por nome, consulte rick_memory/rick_search para a URL antes de perguntar.
12. Quando o usuário ENSINAR algo útil (URLs, preferências), use rick_save_memory para salvar.
13. Em tarefas de código, procure e leia o AGENTS.md do projeto antes de alterar arquivos.
14. Quando o usuário pedir apenas plano/estratégia (sem execução), responda só com o plano.
15. Quando houver chamadas independentes, use batch_tools para executar em paralelo e reduzir interrupcoes/latencia.
16. Para tarefas complexas com 3+ passos, use todo_write para criar uma lista de tarefas e acompanhar progresso. Marque como in_progress ao iniciar e completed ao terminar cada item.
17. Para ler arquivos grandes, use read_file com offset/limit. Para buscar em arquivos, use grep. Para localizar arquivos, use glob.
18. Para alteracoes multi-arquivo ou diff complexo, prefira apply_patch em vez de varios edit_file isolados.

EXECUCAO CONTINUA — SEM PAUSAS INTERMEDIARIAS:
- Quando uma tarefa tem múltiplos passos sequenciais, execute TODOS os passos na mesma rodada sem parar para confirmação intermediária.
- NUNCA diga "se você quiser, eu continuo", "quer que eu prossiga?", "devo continuar?", "posso seguir?" ou qualquer variante. Continue automaticamente até a tarefa estar completa ou um erro real ocorrer.
- Cada pausa desnecessária é tratada como falha operacional. O usuário já autorizou a tarefa ao enviá-la.
- Se atingir um obstáculo real (erro de ferramenta, ambiguidade), resolva-o sozinho ou reporte o bloqueio específico — mas NÃO peça permissão para continuar.

IFRAMES, SHADOW DOM E CONTEUDO DINAMICO:
- Iframes, shadow DOM e SPAs dinâmicas NÃO são bloqueios reais. Use browser_run_code para interagir com conteúdo que browser_click/browser_type não alcançam.
- Só reporte um bloqueio após pelo menos 3 tentativas reais com ferramentas diferentes (browser_click, browser_run_code com locator, browser_press_key).
- NUNCA diga "iframe não ficou acessível", "não apareceu no snapshot", "bloqueio real" ou "componente interno sem elementos" sem ter tentado pelo menos 3 abordagens diferentes via ferramentas.
- Se o snapshot não mostra elementos dentro de um iframe, use browser_run_code para inspecionar o frame diretamente antes de concluir que o conteúdo não existe.
- Exemplos de browser_run_code para iframes:
  Listar frames: async (page) => { const frames = page.frames(); return frames.map(f => ({ url: f.url(), name: f.name() })); }
  Clicar dentro de iframe: async (page) => { const frame = page.frameLocator('iframe#main'); await frame.locator('button.submit').click(); return { ok: true }; }
  Preencher campo em iframe: async (page) => { const frame = page.frameLocator('iframe').first(); await frame.locator('input[name="user"]').fill('valor'); return { ok: true }; }
  Ler texto de iframe: async (page) => { const frame = page.frameLocator('iframe').first(); return await frame.locator('.content').textContent(); }
- Use browser_evaluate para extrair dados simples do DOM: () => document.querySelectorAll('iframe').length

NAVEGADOR (browser_*):
- Os \`ref=eXX\` no snapshot YAML são identificadores internos do Playwright. Use-os APENAS como valor do parâmetro \`ref\` nas tools (ex: browser_click com ref "e51"). NUNCA use como seletor CSS (ex: \`button[ref='e51']\` está ERRADO e vai falhar).
- Se browser_click falhar, tente browser_press_key com Enter ou browser_run_code com um locator diferente ANTES de reportar falha ao usuário.
- Não desista após uma falha de clique. Tente pelo menos 2 abordagens alternativas.`;
}

const PROVIDER_SYSTEM_PROMPTS = {
  gemini: `Diretrizes de provider (Gemini):
- Use um workflow estruturado: 1) Ler/entender → 2) Planejar com todo_write → 3) Executar → 4) Verificar apos cada edit.
- Prefira chamadas de ferramenta pequenas e incrementais. Verifique o resultado de cada edit antes de prosseguir.
- Quando houver resultados extensos, forneca um resumo factual do essencial.
- Em caso de erro de ferramenta, explique a falha e tente uma alternativa segura.
- Use glob e grep ao inves de run_command com find/grep. Use batch_tools para chamadas independentes em paralelo.
- Sempre execute validacao (tsc, testes, build) apos completar alteracoes de codigo.`,

  openai: `Diretrizes de provider (OpenAI/Codex):
- Voce DEVE continuar trabalhando ate o problema estar COMPLETAMENTE resolvido. NUNCA pare antes de terminar.
- Nao peca permissao. Nao pergunte "devo continuar?". Nao peca confirmacao. Faca o trabalho silenciosamente.
- Padrao: faca o trabalho sem fazer perguntas. So pergunte quando: realmente bloqueado apos checar todo o contexto, a requisicao e destrutiva/irreversivel, ou precisa de um segredo.
- Nunca faca perguntas de permissao como "Devo prosseguir?" ou "Posso continuar?".
- Em tarefas de codigo, mantenha execucao incremental e verificavel.
- Nao invente saidas de comandos; cite somente evidencias observadas.
- Use glob e grep para busca de arquivos, nao run_command com find/grep.
- Para alteracoes de codigo em OpenAI/Codex, prefira apply_patch para edicoes multi-arquivo e diffs complexos.
- Use batch_tools agressivamente para paralelizar chamadas independentes.`,

  claude: `Diretrizes de provider (Claude):
- Use todo_write para planejar tarefas com 3+ passos. Marque como in_progress ao iniciar e completed ao terminar.
- Quando chamadas de ferramentas sao independentes, faca TODAS em paralelo via batch_tools. Maximize paralelismo.
- Seja direto, sem floreio, com foco em execucao real.
- Evite repeticao e nao reapresente contexto ja estabelecido.
- Ao finalizar, inclua o que foi alterado e como validou.
- Use glob e grep ao inves de run_command com find/grep.
- Prefira editar arquivos existentes. NUNCA crie arquivos novos a menos que explicitamente necessario.
- Para busca exploratoria que pode exigir multiplas rodadas, use batch_tools com glob e grep em paralelo.`,
};

/**
 * Refresh the system prompt cache.
 * Call before each turn to pick up instruction file changes.
 */
export async function refreshSystemPromptCache(workspace, agentName, toolNames, force = false) {
  const now = Date.now();
  if (!force && now < promptCache.expiresAt) return;

  const [bundle, gitRepo] = await Promise.all([
    buildInstructionBundle(workspace),
    hasGitRepository(workspace),
  ]);

  const cacheChanged = bundle.fingerprint !== promptCache.fingerprint || gitRepo !== promptCache.hasGitRepo;
  if (cacheChanged || force || !activeSystemPrompts.openai) {
    const base = buildBaseSystemPrompt(agentName);
    const environment = environmentPrompt(workspace, gitRepo);
    const toolsBlock = `FERRAMENTAS DISPONIVEIS: ${toolNames.join(", ")}`;
    const shared = [base, toolsBlock, environment, bundle.text].filter(Boolean).join("\n\n");

    activeSystemPrompts.gemini = [shared, PROVIDER_SYSTEM_PROMPTS.gemini].join("\n\n");
    activeSystemPrompts.openai = [shared, PROVIDER_SYSTEM_PROMPTS.openai].join("\n\n");
    activeSystemPrompts.openaiCodex = activeSystemPrompts.openai;
    activeSystemPrompts.claude = [shared, PROVIDER_SYSTEM_PROMPTS.claude].join("\n\n");
    const escapedAgentName = escapeRegex(agentName);
    activeSystemPrompts.claudeOAuth = activeSystemPrompts.claude
      .replace(new RegExp(`${escapedAgentName} Sub-Agent`, "g"), "Claude Code")
      .replace(new RegExp(escapedAgentName, "g"), "Claude");

    promptCache.fingerprint = bundle.fingerprint;
    promptCache.instructionsBlock = bundle.text;
    promptCache.hasGitRepo = gitRepo;
  }

  promptCache.expiresAt = now + PROMPT_CACHE_TTL_MS;
}

function getSharedFallbackPrompt(agentName, toolNames) {
  return [buildBaseSystemPrompt(agentName), `FERRAMENTAS DISPONIVEIS: ${toolNames.join(", ")}`].join("\n\n");
}

export function getGeminiSystemPrompt() {
  return activeSystemPrompts.gemini || "";
}

export function getOpenAISystemPrompt() {
  return activeSystemPrompts.openai || "";
}

export function getOpenAICodexInstructions() {
  return activeSystemPrompts.openaiCodex || getOpenAISystemPrompt();
}

export function getClaudeSystemPrompt(useOAuth = false) {
  if (useOAuth) {
    return activeSystemPrompts.claudeOAuth || "";
  }
  return activeSystemPrompts.claude || "";
}
