import { GoogleGenerativeAI } from "@google/generative-ai";
import { TaskClassification } from "./types.js";
import { config } from "../config/env.js";
import { logger } from "../config/logger.js";

const CLASSIFIER_MODEL = config.gemini.model;

const CLASSIFIER_PROMPT = `Voce e um roteador de mensagens. Classifique a mensagem do usuario.

CATEGORIAS:

SELF — Rick (assistente) responde diretamente. Use para:
- Conversa casual, saudacoes, perguntas simples
- Pedir para lembrar/salvar/esquecer informacoes (memoria)
- Perguntas sobre o proprio Rick ou suas capacidades
- Explicacoes conceituais curtas
- Opinioes, conselhos, dicas rapidas
- Quando o usuario fala COM o assistente diretamente

DELEGATE — Delegar para um sub-agente autonomo. Use quando:
- O usuario pede para criar/implementar/programar/codar algo
- Consertar/debugar bugs em codigo
- Refatorar/revisar codigo existente
- Configurar/deploy de projeto
- Tarefa que requer escrever/modificar arquivos de codigo
- Precisa de informacoes ATUALIZADAS da internet (noticias, precos, dados publicos)
- Pesquisa explicita na web
- Acessar contas/servicos do usuario via browser (email, redes sociais, dashboards)
- Verificar emails, caixa de entrada, notificacoes
- Qualquer tarefa que requer navegar em sites autenticados
- Dados que mudam frequentemente
- Tarefas complexas que requerem multiplos passos

REGRAS:
1. Na DUVIDA = SELF
2. Mencionar tecnologia NAO significa delegar. "Explica React" = SELF
3. "Salve/lembre/guarde" = SELF (memoria)
4. Instrucoes diretas AO Rick = SELF
5. DELEGATE para tarefas que precisam de ACAO (codigo, browser, pesquisa, automacao)

FORMATO DE RESPOSTA (uma unica linha):
CATEGORIA|servico1,servico2

Onde CATEGORIA e SELF ou DELEGATE.
Apos o | liste APENAS os servicos que o usuario EXPLICITAMENTE mencionou na mensagem.
NAO adivinhe servicos que o usuario nao mencionou. Se o usuario fala "email" sem dizer qual provedor, use "email" como hint generico.

Exemplos:
- "Cria um app React com login via Google" → DELEGATE|
- "Faz deploy do meu projeto na Vercel" → DELEGATE|vercel
- "Me explica o que e kubernetes" → SELF|
- "Salva minha senha do gmail" → SELF|
- "Pesquisa as noticias de hoje sobre IA" → DELEGATE|
- "Commita e pusha as alteracoes no meu repo" → DELEGATE|github
- "Configura o CI/CD no meu repo do github" → DELEGATE|github
- "Tem emails nao lidos no meu outlook?" → DELEGATE|outlook
- "Entra no meu email e ve se tem algo" → DELEGATE|email
- "Checa meu gmail" → DELEGATE|gmail

IMPORTANTE: NAO liste "outlook,gmail" juntos a menos que o usuario tenha mencionado ambos.

Responda APENAS com o formato acima. Nada mais.`;

let geminiClient: GoogleGenerativeAI | null = null;

function getClient(): GoogleGenerativeAI {
  if (!geminiClient) {
    geminiClient = new GoogleGenerativeAI(config.gemini.apiKey);
  }
  return geminiClient;
}

/**
 * Classify a user message using Gemini Flash to determine routing.
 * Returns null for SELF (Rick handles directly), or a TaskClassification for DELEGATE.
 */
export async function classifyTask(userMessage: string): Promise<TaskClassification | null> {
  const text = userMessage.trim();

  // Skip very short messages — always SELF
  if (text.length < 10) return null;

  // Skip commands
  if (text.startsWith("/")) return null;

  try {
    const client = getClient();
    const model = client.getGenerativeModel({
      model: CLASSIFIER_MODEL,
      systemInstruction: CLASSIFIER_PROMPT,
    });

    const result = await model.generateContent(text);
    const raw = result.response.text().trim();

    // Parse "CATEGORY|cred1,cred2" format
    const [categoryPart, credsPart] = raw.split("|");
    const category = (categoryPart || "").trim().toUpperCase();
    const credentialHints = (credsPart || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0);

    logger.info(
      { classification: category, credentialHints, text: text.substring(0, 80) },
      "LLM classifier result"
    );

    if (category === "DELEGATE" || category.startsWith("DELEGATE")) {
      return {
        taskDescription: text,
        userMessage: text,
        credentialHints,
      };
    }

    // SELF or anything else — Rick handles directly
    return null;
  } catch (err) {
    logger.warn({ err }, "LLM classifier failed, defaulting to SELF");
    return null;
  }
}
