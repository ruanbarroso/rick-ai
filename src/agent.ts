// Rick AI - Agente pessoal de IA (v3)
import { LLMService } from "./llm/llm-service.js";
import { LLMMessage, MediaAttachment } from "./llm/types.js";
import { GeminiProvider } from "./llm/providers/gemini.js";
import { MemoryService } from "./memory/memory-service.js";
import { VectorMemoryService } from "./memory/vector-memory-service.js";
import { ClaudeOAuthService } from "./auth/claude-oauth.js";
import { OpenAIOAuthService } from "./auth/openai-oauth.js";
import { SessionManager, getSessionRickName } from "./subagent/session-manager.js";
import { EditSession, AuthExpiredCallback, GetFreshTokenCallback, SaveHistoryFn } from "./subagent/edit-session.js";
import { classifyTask } from "./subagent/classifier.js";
import { PendingDelegation } from "./subagent/types.js";
import type { ConnectorManager } from "./connectors/connector-manager.js";
import type { IncomingMessage } from "./connectors/types.js";
import type { WebAgentBridge } from "./connectors/web.js";
import type { WebConnector } from "./connectors/web.js";
import { config } from "./config/env.js";
import { logger } from "./config/logger.js";
import { canLearn, canInvokeSubAgent, canViewSecrets, type UserRole } from "./auth/permissions.js";

export class Agent {
  private llm: LLMService;
  private memory: MemoryService;
  private vectorMemory: VectorMemoryService | null;
  private claudeOAuth: ClaudeOAuthService;
  private openaiOAuth: OpenAIOAuthService;
  private sessionManager: SessionManager;
  private connectorManager: ConnectorManager;

  /**
   * Pending delegation waiting for user to provide missing credentials.
   */
  private pendingDelegation: PendingDelegation | null = null;

  /**
   * Active edit session (/edit mode) — user is directly editing Rick's source.
   * When active, ALL messages bypass the classifier and go straight to Claude Code.
   */
  private editSession: EditSession | null = null;

  /** Tracks whether it's the first message in an edit session (use -p) vs continuation (use --continue) */
  private editFirstPromptSent = false;

  /** Phone of user in current edit session (for token refresh) */
  private editUserPhone: string | null = null;

  /**
   * Per-user message processing lock. Serializes handleMessage calls to prevent
   * race conditions (e.g., two messages arriving while one is being classified).
   * Key: userPhone, Value: promise chain for that user.
   */
  private messageQueue = new Map<string, Promise<string>>();

  /** Reference to web bridge for sending transcription events etc. */
  private webBridge: WebAgentBridge | null = null;

  constructor(
    llm: LLMService,
    memory: MemoryService,
    connectorManager: ConnectorManager,
    vectorMemory?: VectorMemoryService
  ) {
    this.llm = llm;
    this.memory = memory;
    this.connectorManager = connectorManager;
    this.vectorMemory = vectorMemory || null;
    this.claudeOAuth = new ClaudeOAuthService();
    this.openaiOAuth = new OpenAIOAuthService();
    this.sessionManager = new SessionManager(connectorManager, memory);
  }

  /**
   * Recover orphaned sub-agent containers that survived a restart.
   * Call once after all connectors are registered and started.
   */
  async recoverOrphanedSessions(): Promise<number> {
    return this.sessionManager.recoverSessions();
  }

  /**
   * Public entry point — serializes per user to prevent race conditions.
   * Two messages from the same user are processed sequentially, never concurrently.
   * Called by ConnectorManager when any connector receives a message.
   */
  async handleMessage(msg: IncomingMessage): Promise<string> {
    const { userId } = msg;
    const prev = this.messageQueue.get(userId) ?? Promise.resolve("");
    const next = prev
      .catch(() => {}) // don't let a failed message block the queue
      .then(() => this.handleMessageInternal(msg));
    this.messageQueue.set(userId, next);
    return next;
  }

  /**
   * Handle a poll vote from the user.
   * Called by ConnectorManager when a connector receives a poll vote.
   */
  async handlePollVote(
    connectorName: string,
    userPhone: string,
    selectedOptions: string[]
  ): Promise<void> {
    const selected = selectedOptions[0]?.toLowerCase() || "";

    if (selected.includes("sim")) {
      // Kill the session that sent the most recent poll
      const session = this.sessionManager.getLastPollSession();
      if (!session || session.state === "killed") return;

      await this.sessionManager.killSession(session.id);

      const remaining = this.sessionManager.getDoneSessions();
      if (remaining.length > 0) {
        await this.connectorManager.sendMessage(
          connectorName, userPhone,
          `Sessao encerrada! Ainda tem ${remaining.length} sessao(oes) pendente(s).`
        );
      } else {
        await this.connectorManager.sendMessage(connectorName, userPhone, "Sessao encerrada!");
      }
    }
  }

  private async handleMessageInternal(msg: IncomingMessage): Promise<string> {
    const { connectorName, userId: userPhone, userName, text: rawText, media, imageMedias, quotedText, audioUrl, imageUrls, fileInfos } = msg;
    const numericUserId = msg.numericUserId;
    const userRole: UserRole = msg.userRole ?? "admin"; // Default to admin for Web UI (pre-RBAC compat)

    // Get or create user (legacy — only needed when numericUserId is not available)
    // When RBAC is active, the user was already resolved by the connector.
    const user = numericUserId
      ? { id: numericUserId, phone: userPhone, name: userName || null, is_owner: userRole === "admin" }
      : await this.memory.getOrCreateUser(userPhone, userName);

    // If message is a reply to another message, prepend quoted context
    let fullText = rawText;
    if (quotedText) {
      fullText = `[Em resposta a: "${quotedText.substring(0, 300)}"]\n\n${rawText}`;
    }

    // ==================== EDIT MODE ====================
    // When in edit mode, only /exit and /deploy are recognized as commands.
    // Everything else goes directly to Claude Code.
    // Audio is pre-transcribed via Gemini; images are passed via --image flag.
    if (this.editSession) {
      const lower = fullText.trim().toLowerCase();

      if (lower === "/exit") {
        return this.cmdExitEdit();
      }
      if (lower === "/deploy") {
        return this.cmdDeploy();
      }
      if (lower === "/publish" || lower.startsWith("/publish ")) {
        const repoArg = fullText.trim().substring("/publish".length).trim() || undefined;
        return this.cmdPublish(repoArg);
      }

      // If auth expired, check if user is pasting an OAuth code
      if (this.editSession.getState() === "auth_expired") {
        // Check if this looks like a Claude OAuth code (contains # separator)
        if (fullText.includes("#") && this.claudeOAuth.hasPendingAuth()) {
          const result = await this.cmdExchangeClaudeCode(userPhone, fullText);
          if (result?.includes("conectado com sucesso")) {
            // Token exchanged — re-inject into edit session
            const newToken = await this.claudeOAuth.getValidToken(userPhone);
            if (newToken && this.editSession) {
              let refreshToken: string | undefined;
              try {
                const { query: dbQuery } = await import("./memory/db.js");
                const r = await dbQuery(
                  `SELECT refresh_token FROM oauth_tokens WHERE user_phone = $1 AND provider = 'claude' AND is_active = TRUE`,
                  [userPhone]
                );
                refreshToken = r.rows[0]?.refresh_token;
              } catch (_) { /* ignore */ }

              await this.editSession.refreshCredentials(newToken, refreshToken);
              return ""; // refreshCredentials will send its own message and retry
            }
          }
          return result || "Erro ao trocar codigo OAuth.";
        }

        return "Token do Claude expirou. Cole o codigo OAuth para continuar, ou use */exit* para sair.";
      }

      // Proxy everything else to Claude Code
      if (this.editSession.getState() === "deploying") {
        return "Deploy em andamento... Aguarde.";
      }
      if (this.editSession.getState() !== "ready") {
        return "Aguarde, o Claude Code ainda esta processando...";
      }

      // Audio: pre-transcribe with Gemini and fold into text
      // Collect all image medias to forward to edit session (supports multiple images)
      let editMedias: MediaAttachment[] = [];
      if (media?.mimeType.startsWith("audio/")) {
        const transcription = await this.transcribeAudioWithGemini(media);
        const prefix = fullText.trim() ? `${fullText.trim()}\n\n` : "";
        fullText = `${prefix}[Áudio transcrito: "${transcription}"]`;
        editMedias = imageMedias ?? []; // use all images if combined audio+image
        // Send transcription to frontend so "Processando audio..." is replaced
        if (audioUrl && this.webBridge) {
          this.webBridge.sendTranscription(audioUrl, transcription);
        }
      } else if (media?.mimeType.startsWith("image/")) {
        // Primary media is an image — include it plus any extra images in imageMedias
        const extras = (imageMedias ?? []).filter((m) => m !== media);
        editMedias = [media, ...extras];
      } else if (imageMedias && imageMedias.length > 0) {
        // No primary media (or non-image primary) — forward all imageMedias
        editMedias = imageMedias;
      }

      logger.info(
        { editMediaCount: editMedias.length, editMediaMimes: editMedias.map((m) => m.mimeType), textLen: fullText.length },
        "Edit mode: forwarding to Claude Code"
      );

      // Save user message to edit session history (persists across F5 reloads)
      const editSessionIdForSave = this.editSession.id;
      try {
        const { query: dbSaveUser } = await import("./memory/db.js");
        const editImageUrlsJson = imageUrls && imageUrls.length > 0 ? JSON.stringify(imageUrls) : null;
        const editFileInfosJson = fileInfos && fileInfos.length > 0 ? JSON.stringify(fileInfos) : null;
        await dbSaveUser(
          `INSERT INTO session_messages (session_id, role, content, message_type, audio_url, image_urls, file_infos) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [editSessionIdForSave, "user", fullText, "text", audioUrl || null, editImageUrlsJson, editFileInfosJson]
        );
      } catch (err) {
        logger.warn({ err }, "Failed to save edit session user message");
      }

      // First message uses -p, subsequent use --continue
      if (!this.editFirstPromptSent) {
        this.editFirstPromptSent = true;
        this.editSession.sendPrompt(fullText, editMedias.length > 0 ? editMedias : undefined).catch((err) => {
          logger.error({ err }, "Edit session prompt failed");
        });
      } else {
        this.editSession.sendContinue(fullText, editMedias.length > 0 ? editMedias : undefined).catch((err) => {
          logger.error({ err }, "Edit session continue failed");
        });
      }
      return ""; // Response will come async from Claude Code stream
    }

    // ==================== AUDIO TRANSCRIPTION ====================
    // Audio messages are transcribed here so that the rest of the pipeline
    // (commands, classifier, sub-agent relay) treats them as normal text.
    // Without this, audio bypasses all routing and goes straight to simple chat,
    // which can cause hallucinations (e.g., claiming to delete emails it never touched).
    let routingMedia = media; // keep original for simple chat (image support)
    if (media?.mimeType.startsWith("audio/")) {
      const transcription = await this.transcribeAudioWithGemini(media);
      const trimmedText = fullText.trim();
      const isAudioPlaceholder = /o usuario enviou um audio/i.test(trimmedText);
      const isCombinedPlaceholder = /o usuario enviou um audio e imagens?/i.test(trimmedText);
      const prefix = trimmedText && !isAudioPlaceholder && !isCombinedPlaceholder ? `${trimmedText}\n\n` : "";
      fullText = `${prefix}${transcription}`;
      // If there are separate images, use them for vision; otherwise clear media
      routingMedia = imageMedias?.[0] || undefined;
      logger.info({ transcription: transcription.substring(0, 80), imageCount: imageMedias?.length || 0 }, "Audio transcribed for routing");

      // Send transcription to frontend so it appears under the audio player
      if (audioUrl && this.webBridge) {
        this.webBridge.sendTranscription(audioUrl, transcription);
      }
    }

    // Check for direct commands first (only for text messages)
    // handleCommand returns null if not a command, or a string (possibly empty) if it is
    if (!routingMedia) {
      const commandResult = await this.handleCommand(userPhone, connectorName, fullText, numericUserId, userRole);
      if (commandResult !== null) return commandResult;
    }

    // If there's a pending delegation waiting for credentials, handle it
    if (this.pendingDelegation && !routingMedia) {
      return this.handlePendingCredential(userPhone, connectorName, fullText, numericUserId, userRole);
    }

    // Show typing indicator while processing (classification + LLM call can take several seconds)
    await this.connectorManager.setTyping(connectorName, userPhone, true);
    try {
      // Keep OAuth tokens fresh — needed for sub-agent LLM fallback
      await this.ensureOAuthTokens(userPhone);

      // Collect all images for potential sub-agent forwarding
      const allImageMedias: MediaAttachment[] = [];
      if (routingMedia && routingMedia.mimeType.startsWith("image/")) allImageMedias.push(routingMedia);
      if (imageMedias) {
        for (const img of imageMedias) {
          if (!allImageMedias.includes(img)) allImageMedias.push(img);
        }
      }

      // If there are sessions with pending "done" polls, handle the 3 cases:
      // 1. Encerrar (explicit close words)
      // 2. Continuidade (adjust/fix on the same session)
      // 3. Novo pedido (different topic → nag to close first)
      // Skip this interception when the message comes from Web UI's main session
      // (sub-agents have their own dedicated panels there).
      if (this.sessionManager.hasDoneSessions() && !msg.skipSubAgentRelay) {
        return this.handleSubAgentRelay(userPhone, connectorName, fullText, audioUrl, imageUrls, allImageMedias, fileInfos, numericUserId);
      }

      // Classify the task — does it need a sub-agent?
      // Skip classification for roles that cannot invoke sub-agents (business)
      const classification = canInvokeSubAgent(userRole) ? await classifyTask(fullText) : null;

      // If a sub-agent is already running, only block new DELEGATE tasks.
      // SELF tasks (save memory, answer questions, etc.) are handled normally
      // by the main session, independently of any running sub-agent.
      if (this.sessionManager.getRunningSessions().length > 0) {
        if (classification) {
          return "O sub-agente ainda esta trabalhando... Aguarde um momento.";
        }
        // SELF task — fall through to handleSimpleChat below
      } else if (classification) {
        return this.delegateToSubAgent(
          userPhone,
          connectorName,
          fullText,
          classification.credentialHints,
          {},
          audioUrl,
          imageUrls,
          allImageMedias,
          fileInfos,
          numericUserId
        );
      }

      // Simple chat — Gemini Flash handles directly
      // Combine all image media: routingMedia (first image or single image) + imageMedias (remaining)
      let allMedia: MediaAttachment | MediaAttachment[] | undefined = routingMedia;
      if (routingMedia && imageMedias && imageMedias.length > 0) {
        // If we have routingMedia, it is ALWAYS imageMedias[0].
        // imageMedias ALREADY contains all images. So we just use imageMedias directly.
        allMedia = imageMedias;
      } else if (!routingMedia && imageMedias && imageMedias.length > 0) {
        allMedia = imageMedias.length === 1 ? imageMedias[0] : imageMedias;
      }
      return this.handleSimpleChat(userPhone, user.name, fullText, allMedia, audioUrl, imageUrls, fileInfos, userRole, numericUserId);
    } finally {
      await this.connectorManager.setTyping(connectorName, userPhone, false);
    }
  }

  /**
   * Handle simple chat via Gemini Flash (default path).
   */
  private async handleSimpleChat(
    userPhone: string,
    userName: string | null,
    text: string,
    media?: MediaAttachment | MediaAttachment[],
    audioUrl?: string,
    imageUrls?: string[],
    fileInfos?: Array<{ url: string; name: string; mimeType: string }>,
    userRole: UserRole = "admin",
    numericUserId?: number
  ): Promise<string> {
    // RBAC: Use global memory context with role-based filtering
    const memoryContext = await this.memory.buildGlobalMemoryContext(userRole);
    const semanticContext = await this.buildSemanticContext(userPhone, text, userRole);

    // Use user_id-based history if available, otherwise fallback to phone-based
    const history = numericUserId
      ? await this.memory.getConversationHistoryByUserId(numericUserId)
      : await this.memory.getConversationHistory(userPhone);

    const systemPrompt = this.buildSystemPrompt(userName, memoryContext, semanticContext, userRole);

    const messages: LLMMessage[] = [
      // Filter out tool_use messages — they are notifications (e.g. "[tool] Pesquisando...")
      // and should not be included in the LLM conversation context.
      ...history
        .filter((h) => h.message_type !== "tool_use")
        .map((h) => ({
          role: h.role as "user" | "assistant",
          content: h.content,
        })),
      { role: "user" as const, content: text, media },
    ];

    // Save user message BEFORE the LLM call so it persists even if the call fails/crashes
    if (numericUserId) {
      await this.memory.saveMessageByUserId(numericUserId, "user", text, undefined, undefined, audioUrl, imageUrls, undefined, fileInfos);
    } else {
      await this.memory.saveMessage(userPhone, "user", text, undefined, undefined, audioUrl, imageUrls, undefined, fileInfos);
    }

    let response;
    try {
      response = await this.llm.chat(messages, systemPrompt);
    } catch (err: any) {
      logger.error({ userPhone, model: this.llm.getActiveModel().id, err: err.message }, "Gemini Flash failed — no fallback");
      return `Erro no Gemini: ${err.message?.substring(0, 200) || "erro desconhecido"}.\nTente novamente em alguns segundos.`;
    }

    if (numericUserId) {
      await this.memory.saveMessageByUserId(numericUserId, "assistant", response.content, response.model, response.tokensUsed);
    } else {
      await this.memory.saveMessage(userPhone, "assistant", response.content, response.model, response.tokensUsed);
    }

    // RBAC: Only extract memories and embed if user role allows learning
    if (canLearn(userRole)) {
      await this.extractAndSaveMemories(userPhone, text, response.content, userRole, numericUserId);

      this.autoEmbedConversation(userPhone, text, response.content, numericUserId).catch(
        (err) => logger.warn({ err }, "Failed to auto-embed conversation")
      );
    }

    return response.content;
  }

  /**
   * Delegate a task to a unified sub-agent.
   * Resolves credentials from memory and asks user for any missing ones.
   */
  private async delegateToSubAgent(
    userPhone: string,
    connectorName: string,
    userMessage: string,
    credentialHints: string[] = [],
    preResolvedCredentials: Record<string, string> = {},
    audioUrl?: string,
    imageUrls?: string[],
    imageMedias?: MediaAttachment[],
    fileInfos?: Array<{ url: string; name: string; mimeType: string }>,
    numericUserId?: number
  ): Promise<string> {
    // Build env vars for the sub-agent container — all available LLM keys
    const env: Record<string, string> = {};

    // Anthropic (Claude) — try OAuth token first, then API key
    const claudeToken = await this.claudeOAuth.getValidToken(userPhone);
    if (claudeToken) {
      env.ANTHROPIC_ACCESS_TOKEN = claudeToken;
    } else if (config.anthropic?.apiKey) {
      env.ANTHROPIC_API_KEY = config.anthropic.apiKey;
    }

    // OpenAI (GPT) — try OAuth token first, then API key
    const openaiToken = await this.openaiOAuth.getValidToken(userPhone);
    if (openaiToken) {
      env.OPENAI_ACCESS_TOKEN = openaiToken.accessToken;
      if (openaiToken.accountId) {
        env.OPENAI_ACCOUNT_ID = openaiToken.accountId;
      }
    } else if (config.openai?.apiKey) {
      env.OPENAI_API_KEY = config.openai.apiKey;
    }

    // Gemini — always from config
    if (config.gemini?.apiKey) {
      env.GEMINI_API_KEY = config.gemini.apiKey;
    }

    // Database read-only access
    if (config.databaseUrl) {
      env.DATABASE_URL = config.databaseUrl;
    }
    if (config.vectorDatabaseUrl) {
      env.PGVECTOR_URL = config.vectorDatabaseUrl;
    }

    // GitHub token (from config store / Web UI settings)
    if (process.env.GITHUB_TOKEN) {
      env.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
    }

    // Expand generic "email" hint into actual email providers found in memory
    const emailProviders = ["outlook", "gmail", "hotmail", "yahoo", "protonmail"];
    let expandedHints = [...credentialHints];
    if (expandedHints.includes("email")) {
      expandedHints = expandedHints.filter((h) => h !== "email");
      // Use global memory list (memories are global in RBAC model)
      const allMemories = await this.memory.listGlobalMemories();
      const emailCreds = allMemories.filter(
        (m) =>
          ["credenciais", "senhas", "contatos"].includes(m.category.toLowerCase()) &&
          emailProviders.some((ep) => m.key.toLowerCase().includes(ep) || m.value.toLowerCase().includes(ep))
      );
      if (emailCreds.length > 0) {
        const foundProviders = emailCreds.map((m) => m.key.toLowerCase());
        expandedHints.push(...foundProviders);
        logger.info({ original: "email", expanded: foundProviders }, "Expanded generic 'email' hint to known providers");
      } else {
        expandedHints.push("email");
      }
    }

    // Resolve credentials from memory for the hinted services
    const resolved: Record<string, string> = { ...preResolvedCredentials };
    const missing: string[] = [];

    for (const hint of expandedHints) {
      if (resolved[hint]) continue;
      const found = await this.findCredentialInMemory(userPhone, hint);
      if (found) {
        resolved[hint] = found;
        logger.info({ hint, found: found.substring(0, 20) + "..." }, "Credential found in memory");
      } else {
        missing.push(hint);
      }
    }

    // If ALL credentials are missing and at least one was hinted, ask the user.
    if (missing.length > 0 && Object.keys(resolved).length === 0) {
      this.pendingDelegation = {
        userMessage,
        resolvedCredentials: resolved,
        missingCredentials: missing,
        connectorName,
        userId: userPhone,
        createdAt: Date.now(),
      };

      const missingList = missing.map((m) => `*${m}*`).join(", ");
      if (numericUserId) {
        await this.memory.saveMessageByUserId(numericUserId, "user", userMessage, undefined, undefined, audioUrl, imageUrls, undefined, fileInfos);
      } else {
        await this.memory.saveMessage(userPhone, "user", userMessage, undefined, undefined, audioUrl, imageUrls, undefined, fileInfos);
      }
      return `Vou precisar de credenciais para ${missingList} pra fazer isso.\n\nMe manda as credenciais de *${missing[0]}* (usuario, senha, token, o que for necessario).`;
    }

    if (missing.length > 0) {
      logger.info({ missing, resolved: Object.keys(resolved) }, "Proceeding with partial credentials");
    }

    if (numericUserId) {
      await this.memory.saveMessageByUserId(numericUserId, "user", userMessage, undefined, undefined, audioUrl, imageUrls, undefined, fileInfos);
    } else {
      await this.memory.saveMessage(userPhone, "user", userMessage, undefined, undefined, audioUrl, imageUrls, undefined, fileInfos);
    }

    // Start the sub-agent container
    let session;
    try {
      session = await this.sessionManager.createSession(
        userMessage, connectorName, userPhone, resolved, env, imageMedias, numericUserId
      );
    } catch (err) {
      logger.error({ err }, "Sub-agent session failed");
      return `Erro ao executar sub-agente: ${(err as Error).message}`;
    }

    // Build ack with Rick variant name + public session link
    const rickName = getSessionRickName(session.id);
    const baseUrl = config.webBaseUrl || `https://rick.barroso.tec.br`;
    const sessionUrl = `${baseUrl}/s/${session.id}`;

    const ack = `O *${rickName}* vai cuidar disso pra voce, pode acompanhar aqui:\n${sessionUrl}`;

    if (numericUserId) {
      await this.memory.saveMessageByUserId(numericUserId, "assistant", ack);
    } else {
      await this.memory.saveMessage(userPhone, "assistant", ack);
    }

    return ack;
  }

  /**
   * Search user's memories for credentials matching a service name.
   * Looks in categories: senhas, credenciais, tokens, contatos, general.
   */
  private async findCredentialInMemory(userPhone: string, service: string): Promise<string | null> {
    // Search by key match in credential-related categories (global memories)
    const results = await this.memory.recallGlobal(service);

    // Filter for credential-like categories
    const credCategories = ["senhas", "credenciais", "tokens", "passwords", "secrets", "contatos", "general"];
    const credResult = results.find((m) => credCategories.includes(m.category.toLowerCase()));

    if (credResult) {
      return credResult.value;
    }

    // Also try searching with common variations
    const variations = [
      `senha ${service}`,
      `login ${service}`,
      `token ${service}`,
      `credencial ${service}`,
      `usuario ${service}`,
    ];

    for (const variation of variations) {
      const varResults = await this.memory.recallGlobal(variation);
      if (varResults.length > 0) {
        // Collect all matches for this service
        const all = varResults
          .filter((m) => credCategories.includes(m.category.toLowerCase()))
          .map((m) => m.value)
          .join("\n");
        if (all) return all;
      }
    }

    // Search all global memories in credential categories for a mention of the service
    const allMemories = await this.memory.listGlobalMemories();
    const serviceMatches = allMemories.filter(
      (m) =>
        credCategories.includes(m.category.toLowerCase()) &&
        (m.key.toLowerCase().includes(service) ||
          m.value.toLowerCase().includes(service))
    );

    if (serviceMatches.length > 0) {
      return serviceMatches.map((m) => m.value).join("\n");
    }

    // Last resort: search pgvector semantic memory for credential-related content.
    // STRICT FILTER: Only return results that look like actual credential data,
    // not conversation snippets that merely mention the service name.
    if (this.vectorMemory) {
      try {
        const vectorResults = await this.vectorMemory.searchGlobal(
          `credenciais ${service} senha usuario login`,
          5,
          0.5 // higher threshold for better precision
        );
        // A result is credential-like only if it contains BOTH the service name
        // AND actual credential data patterns (e.g., "senha: X" or "usuario: X" or "@")
        const credPatterns = [
          /senha\s*[:=]\s*\S+/i,        // "senha: abc123" or "senha=abc123"
          /usu[aá]rio\s*[:=]\s*\S+/i,   // "usuario: joao"
          /login\s*[:=]\s*\S+/i,         // "login: joao"
          /token\s*[:=]\s*\S+/i,         // "token: xyz"
          /\S+@\S+\.\S+/,               // email addresses
          /password\s*[:=]\s*\S+/i,      // "password: abc"
        ];
        const credMatches = vectorResults.filter((m) => {
          const lower = m.content.toLowerCase();
          if (!lower.includes(service)) return false;
          // Must match at least one credential-data pattern
          return credPatterns.some((p) => p.test(m.content));
        });
        if (credMatches.length > 0) {
          logger.info({ service, matchCount: credMatches.length }, "Found credential in vector memory (strict)");
          return credMatches.map((m) => m.content).join("\n");
        }
      } catch (err) {
        logger.warn({ err, service }, "Vector memory credential search failed");
      }
    }

    return null;
  }

  /**
   * Handle a message when there's a pending delegation waiting for credentials.
   */
  private async handlePendingCredential(
    userPhone: string,
    connectorName: string,
    text: string,
    numericUserId?: number,
    userRole: UserRole = "admin"
  ): Promise<string> {
    const pending = this.pendingDelegation!;

    // Check if user wants to cancel
    const lower = text.trim().toLowerCase();
    if (lower === "cancelar" || lower === "cancela" || lower === "nao" || lower === "deixa") {
      this.pendingDelegation = null;
      return "Ok, cancelei a tarefa.";
    }

    // User is providing the credential for the first missing one
    const currentMissing = pending.missingCredentials[0];

    // Save the credential to memory (global in RBAC model)
    if (numericUserId) {
      await this.memory.rememberV2(currentMissing, text.trim(), "credenciais", numericUserId, userRole);
    } else {
      await this.memory.remember(userPhone, currentMissing, text.trim(), "credenciais");
    }
    pending.resolvedCredentials[currentMissing] = text.trim();
    pending.missingCredentials.shift();

    logger.info(
      { service: currentMissing, remaining: pending.missingCredentials.length },
      "Credential received and saved"
    );

    // Still more missing?
    if (pending.missingCredentials.length > 0) {
      const next = pending.missingCredentials[0];
      return `Salvei as credenciais de *${currentMissing}*.\n\nAgora me manda as credenciais de *${next}*.`;
    }

    // All credentials resolved — proceed with delegation
    this.pendingDelegation = null;
    return this.delegateToSubAgent(
      userPhone,
      connectorName,
      pending.userMessage,
      [], // no more hints to resolve
      pending.resolvedCredentials,
      undefined, // audioUrl
      undefined, // imageUrls
      undefined, // imageMedias
      undefined, // fileInfos
      numericUserId
    );
  }

  /**
   * Relay a message to the active sub-agent session.
   * Handles: user answers to questions, follow-up requests, or "ok" to kill.
   */
  private async handleSubAgentRelay(
    userPhone: string,
    connectorName: string,
    text: string,
    audioUrl?: string,
    imageUrls?: string[],
    imageMedias?: MediaAttachment[],
    fileInfos?: Array<{ url: string; name: string; mimeType: string }>,
    numericUserId?: number
  ): Promise<string> {
    const doneSessions = this.sessionManager.getDoneSessions();
    if (doneSessions.length === 0) return "Nenhuma sessao pendente.";

    const lower = text.trim().toLowerCase();
    const mostRecent = this.sessionManager.getMostRecentDoneSession()!;

    // CASE 1: Explicit close — kill session(s)
    const closeIntent =
      lower === "ok" ||
      lower === "pronto" ||
      lower === "finalizar" ||
      lower === "encerrar" ||
      lower === "fechar" ||
      lower === "sim" ||
      /\b(pode\s+encerrar|pode\s+finalizar|pode\s+fechar|encerrar\s+isso|fechar\s+isso)\b/i.test(lower);

    if (closeIntent) {
      const closeAll = /\b(tudo|todas|todos|geral)\b/i.test(lower);
      if (closeAll) {
        const killed = await this.sessionManager.killAll();
        return killed > 0 ? `Encerrei ${killed} sessao(oes).` : "Nao havia sessoes para encerrar.";
      }

      await this.sessionManager.killSession(mostRecent.id);
      const remaining = this.sessionManager.getDoneSessions();
      if (remaining.length > 0) {
        return `Sessao encerrada! Ainda tem ${remaining.length} sessao(oes) pendente(s). Marca *Sim* na enquete ou me diz o que precisa.`;
      }
      return "Sessao encerrada!";
    }

    // For cases 2 and 3, we need to classify the intent
    // CASE 2: Continuation — user wants to adjust/fix/follow-up on the same session
    // CASE 3: New task — user wants something completely different
    //
    // First check if the message seems related to the most recent session topic.
    // Short follow-up questions (< 80 chars) that reference the same domain are continuations.
    const prevTask = mostRecent.taskDescription.toLowerCase();
    const prevOutput = (mostRecent.output || "").toLowerCase();
    const isShortFollowUp = text.length < 100;
    const sharesTopic = (
      // Same keywords between user message and previous task/output
      lower.split(/\s+/).some(w => w.length > 3 && (prevTask.includes(w) || prevOutput.includes(w))) ||
      // Demonstrative references ("esses", "esses emails", "mais detalhes", "detalha", "explica")
      /\b(ess[ea]s?|aquel[ea]s?|isso|diss[eo]|mais\s*detalh|detalh[ae]|explic|mostr[ae]|list[ae]|quais|qual|como)\b/i.test(text)
    );

    const isContinuation = isShortFollowUp && sharesTopic;

    if (!isContinuation) {
      // Use classifier as tiebreaker
      const classification = await classifyTask(text);
      // If classifier says it's a new task (CODE/RESEARCH) AND it doesn't share the topic, nag
      if (classification) {
        const sessionList = doneSessions
          .map((s) => `- "${s.taskDescription.substring(0, 60)}..."`)
          .join("\n");
        return `Antes de abrir outra sessao, preciso que voce resolva as pendentes:\n\n${sessionList}\n\nMarca *Sim* na enquete pra encerrar, ou me pede um ajuste nessa mesma sessao.`;
      }
    } else {
      logger.info({ text: text.substring(0, 60), sessionId: mostRecent.id }, "Treating as session continuation (topic match)");
    }

    // CASE 2: Continuation — relay to the most recent done session
    if (numericUserId) {
      await this.memory.saveMessageByUserId(numericUserId, "user", text, undefined, undefined, audioUrl, imageUrls, undefined, fileInfos);
    } else {
      await this.memory.saveMessage(userPhone, "user", text, undefined, undefined, audioUrl, imageUrls, undefined, fileInfos);
    }

    this.sessionManager.sendToSession(mostRecent.id, text, imageMedias, audioUrl, imageUrls, fileInfos).catch(async (err) => {
      logger.error({ err }, "Sub-agent relay failed");
      await this.connectorManager.sendMessage(
        connectorName, userPhone,
        `Erro no sub-agente: ${(err as Error).message}`
      );
    });

    return "Entendido, ajustando na mesma sessao...";
  }

  /**
   * Ensure the LLM service has the user's OAuth tokens if they're connected.
   */
  private async ensureOAuthTokens(userPhone: string): Promise<void> {
    // Claude
    try {
      const claudeToken = await this.claudeOAuth.getValidToken(userPhone);
      this.llm.setAnthropicOAuthToken(claudeToken);
    } catch (err) {
      logger.warn({ err }, "Failed to get Claude OAuth token");
      this.llm.setAnthropicOAuthToken(null);
    }

    // OpenAI
    try {
      const openaiData = await this.openaiOAuth.getValidToken(userPhone);
      if (openaiData) {
        this.llm.setOpenAIOAuthToken(openaiData.accessToken, openaiData.accountId);
      } else {
        this.llm.setOpenAIOAuthToken(null);
      }
    } catch (err) {
      logger.warn({ err }, "Failed to get OpenAI OAuth token");
      this.llm.setOpenAIOAuthToken(null);
    }
  }

  private buildSystemPrompt(
    userName: string | null,
    memoryContext: string,
    semanticContext: string,
    userRole: UserRole = "admin"
  ): string {
    const name = config.agentName;
    const userRef = userName ? userName : "o usuario";

    const hasSemanticMemory = !!this.vectorMemory;

    let prompt = `Voce e ${name}. Estou a disposicao para ajudar com o que for necessario.

REGRAS IMPORTANTES:
1. Responda sempre em portugues brasileiro, a menos que o usuario fale em outro idioma.
2. Seja direto e conciso — mensagens curtas.
3. Use formatacao simples (*negrito*, _italico_, ~tachado~, \`\`\`codigo\`\`\`).
4. Voce tem memoria persistente. Quando o usuario pedir para lembrar algo, responda confirmando.
5. Quando o usuario pedir para esquecer algo, confirme que esqueceu.
6. Voce conhece ${userRef} e deve usar o que sabe sobre ele(a) para personalizar respostas.
7. Se o usuario compartilhar informacoes pessoais (nome, preferencias, links, senhas, etc.), lembre-se delas automaticamente.
8. Para senhas e dados sensiveis, avise que esta armazenando mas recomende um gerenciador de senhas.${hasSemanticMemory ? `
9. Voce tem memoria semantica — consegue lembrar de conversas passadas e buscar por significado, nao apenas por palavras exatas.` : ""}

CAPACIDADES:
- Voce roda no Gemini Flash para conversa direta.
- Voce tem acesso a memorias estruturadas (chave-valor)${hasSemanticMemory ? " e semanticas (busca por significado)" : ""}
- Voce pode listar, buscar, ou apagar memorias
- O usuario pode conectar contas com /conectar claude ou /conectar gpt (amplia os modelos disponiveis para o sub-agente)
- Voce tem um sub-agente autonomo que pode delegar tarefas complexas. Ele e capaz de programar, pesquisar na web, acessar contas do usuario via browser, e executar acoes em servicos externos. O roteamento e automatico — voce nao precisa escolher tipo de sub-agente.
- Quando o sub-agente precisa de credenciais (senhas, tokens, etc.), voce primeiro busca na sua memoria. Se nao tem, pergunta ao usuario, salva, e entao executa.
- Credenciais salvas ficam na categoria "credenciais" ou "senhas" da sua memoria

REGRA ANTI-ALUCINACAO (CRITICA — NUNCA viole):
- NUNCA invente informacoes que voce nao tem. Se nao sabe, diga que nao sabe.
- NUNCA finja ter executado acoes que nao executou. Se o sub-agente nao retornou resultado, NAO invente um resultado.
- NUNCA fabrique dados ficticios (emails, notificacoes, mensagens, etc).
- Quando o usuario pedir algo que requer o sub-agente (codigo, pesquisa, acessar emails), o roteamento e automatico. NAO tente responder voce mesmo fingindo que acessou algo.
- Se voce nao tem certeza se pode fazer algo, diga honestamente e sugira alternativas.
- VOCE NAO TEM ACESSO A NENHUM SERVICO EXTERNO (email, sites, contas). Somente o sub-agente pode acessar. Se o usuario pedir para APAGAR, ENVIAR, MODIFICAR, ou REALIZAR qualquer acao em uma conta ou servico externo, diga: "Preciso acionar o sub-agente pra isso. Vou delegar a tarefa." NAO diga que fez a acao voce mesmo. NUNCA diga "Pronto, apaguei" ou "Feito, enviei" — isso e MENTIRA se voce nao delegou ao sub-agente.`;

    // ==================== RBAC: Role-specific instructions ====================
    if (userRole === "admin") {
      prompt += `\n\nVoce esta conversando com o administrador. Pode acessar e revelar todos os segredos quando solicitado.`;
    } else if (userRole === "dev") {
      prompt += `\n\nVoce esta conversando com um desenvolvedor.`;
      prompt += `\nNUNCA revele valores de senhas, credenciais, tokens ou segredos ao usuario.`;
      prompt += `\nVoce pode usar os segredos internamente para executar tarefas, mas nunca mostre os valores.`;
      prompt += `\nSe o usuario pedir para ver um segredo, responda que voce nao tem permissao para revelar essa informacao.`;
      prompt += `\nQuando memorizar algo novo, verifique se ja existe uma memoria com a mesma chave criada por outro usuario.`;
      prompt += `\nSe existir e foi criada por outro desenvolvedor, questione: "Eu aprendi com outro usuario que [valor existente], tem certeza que e [novo valor]?"`;
      prompt += `\nSe existir e foi criada pelo administrador, NUNCA sobrescreva. Responda: "Sinto muito, mas o administrador me ensinou que na verdade e [valor existente]".`;
    } else if (userRole === "business") {
      prompt += `\n\nVoce esta conversando com um usuario de negocio.`;
      prompt += `\nNUNCA revele valores de senhas, credenciais, tokens ou segredos.`;
      prompt += `\nNAO memorize informacoes novas desta conversa.`;
      prompt += `\nNAO invoque sub-agentes para este usuario.`;
    }

    prompt += `\n\nDATA E HORA ATUAL: ${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "full", timeStyle: "short" })}`;

    prompt += `\n\n${memoryContext}${semanticContext}`;

    return prompt;
  }

  private async handleCommand(
    userPhone: string,
    connectorName: string,
    text: string,
    numericUserId?: number,
    userRole: UserRole = "admin"
  ): Promise<string | null> {
    const lower = text.trim().toLowerCase();

    // ==================== OAUTH COMMANDS ====================

    // /conectar claude
    if (lower === "/conectar claude") {
      return this.cmdConnectClaude(userPhone);
    }

    // /conectar gpt
    if (lower === "/conectar gpt" || lower === "/conectar openai") {
      return this.cmdConnectGPT(userPhone);
    }

    // /conectar (generic)
    if (lower === "/conectar") {
      return `Qual provedor conectar?\n\n/conectar claude — Claude Pro/Max\n/conectar gpt — ChatGPT Pro (GPT Codex)`;
    }

    // /desconectar claude
    if (lower === "/desconectar claude") {
      return this.cmdDisconnectClaude(userPhone);
    }

    // /desconectar gpt
    if (lower === "/desconectar gpt" || lower === "/desconectar openai") {
      return this.cmdDisconnectGPT(userPhone);
    }

    // /desconectar (generic)
    if (lower === "/desconectar") {
      return `Qual provedor desconectar?\n\n/desconectar claude\n/desconectar gpt`;
    }

    // Check if user is pasting a Claude OAuth code (contains # and not a command)
    if (this.claudeOAuth.hasPendingAuth() && text.includes("#") && !text.startsWith("/")) {
      const exchangeResult = await this.cmdExchangeClaudeCode(userPhone, text);
      if (exchangeResult) return exchangeResult;
    }

    // Check if user is pasting an OpenAI OAuth callback URL
    if (this.openaiOAuth.hasPendingAuth() && text.includes("localhost") && text.includes("code=")) {
      return this.cmdExchangeGPTCallback(userPhone, text);
    }

    // ==================== MEMORY COMMANDS ====================

    if (lower.startsWith("/lembrar ")) {
      return this.cmdRemember(userPhone, text.slice(9).trim(), numericUserId, userRole);
    }

    if (lower.startsWith("/esquecer ")) {
      return this.cmdForget(userPhone, text.slice(10).trim());
    }

    if (lower === "/esquecer_tudo") {
      // Use global forgetAll (memories are global in RBAC model)
      const count = await this.memory.forgetAllGlobal();
      return `Pronto, esqueci ${count} memorias. Mente limpa!`;
    }

    if (lower.startsWith("/memorias")) {
      const category = text.slice(9).trim() || undefined;
      return this.cmdListMemories(userPhone, category);
    }

    if (lower.startsWith("/buscar ")) {
      return this.cmdSearch(userPhone, text.slice(8).trim());
    }

    // ==================== CONVERSATION COMMANDS ====================

    if (lower === "/limpar") {
      if (numericUserId) {
        await this.memory.clearConversationByUserId(numericUserId);
      } else {
        await this.memory.clearConversation(userPhone);
      }
      return "Historico de conversa limpo! Comecamos do zero.";
    }

    if (lower.startsWith("/modelo") || lower === "/modelo") {
      return this.cmdShowModels(userPhone);
    }

    if (lower.startsWith("/vsearch ") || lower.startsWith("/vbuscar ")) {
      const prefix = lower.startsWith("/vsearch ") ? "/vsearch " : "/vbuscar ";
      return this.cmdVectorSearch(userPhone, text.slice(prefix.length).trim());
    }

    if (lower === "/matar" || lower === "/kill") {
      return this.cmdKillSubAgent();
    }

    // ==================== EDIT MODE ====================

    if (lower === "/edit") {
      return this.cmdStartEdit(userPhone, connectorName);
    }

    // /exit and /deploy are handled in the edit mode block at top of handleMessage
    // But if called outside edit mode, give a helpful message
    if (lower === "/exit") {
      return "Voce nao esta no modo de edicao. Use */edit* para entrar.";
    }
    if (lower === "/deploy") {
      return "Voce nao esta no modo de edicao. Use */edit* primeiro.";
    }

    if (lower === "/help" || lower === "/ajuda") {
      return this.cmdHelp(userPhone);
    }

    if (lower === "/status") {
      return this.cmdStatus(userPhone, numericUserId);
    }

    return null;
  }

  // ==================== CLAUDE OAUTH ====================

  private async cmdConnectClaude(userPhone: string): Promise<string> {
    const status = await this.claudeOAuth.isConnected(userPhone);
    if (status.connected) {
      return `Ja conectado ao Claude! (${status.email || "conta conectada"})\n\nPara desconectar: /desconectar claude`;
    }

    const { authUrl } = this.claudeOAuth.startAuth();

    return `*Conectar Claude Pro/Max*

1. Abra este link no navegador (logado na sua conta Claude):

${authUrl}

2. Autorize o acesso.

3. A pagina vai mostrar um *codigo* no formato \`codigo#state\`.

4. *Copie e cole o codigo inteiro aqui* (com o #).

O link expira em 10 minutos.`;
  }

  private async cmdExchangeClaudeCode(
    userPhone: string,
    rawCode: string
  ): Promise<string | null> {
    const result = await this.claudeOAuth.exchangeCode(userPhone, rawCode);

    if (!result.success) {
      return result.error || "Erro ao conectar. Tente novamente com /conectar claude.";
    }

    // Set the token in LLM service immediately
    const token = await this.claudeOAuth.getValidToken(userPhone);
    if (token) {
      this.llm.setAnthropicOAuthToken(token);
    }

    return `*Claude conectado com sucesso!*

Conta: ${result.email || "conectada"}

O sub-agente agora pode usar o Claude Opus. O token e renovado automaticamente.`;
  }

  private async cmdDisconnectClaude(userPhone: string): Promise<string> {
    const status = await this.claudeOAuth.isConnected(userPhone);
    if (!status.connected) {
      return "Nao esta conectado ao Claude. Use /conectar claude.";
    }

    await this.claudeOAuth.disconnect(userPhone);
    this.llm.setAnthropicOAuthToken(null);

    const active = this.llm.getActiveModel();
    if (active.provider === "anthropic") {
      this.llm.switchModel("gemini flash");
      return `Claude desconectado. Modelo trocado para *gemini flash*.`;
    }
    return "Claude desconectado.";
  }

  // ==================== GPT OAUTH (DEVICE AUTH) ====================

  private async cmdConnectGPT(userPhone: string): Promise<string> {
    const status = await this.openaiOAuth.isConnected(userPhone);
    if (status.connected) {
      return `Ja conectado ao GPT! (${status.email || "conta conectada"})\n\nPara desconectar: /desconectar gpt`;
    }

    const { authUrl } = this.openaiOAuth.startAuth();

    return `*Conectar ChatGPT Pro (GPT Codex)*

1. Abra este link no navegador (logado na sua conta OpenAI):

${authUrl}

2. Autorize o acesso e clique *Continuar*.

3. O navegador vai redirecionar para uma pagina que *nao vai carregar* (localhost). Isso e normal!

4. *Copie a URL inteira da barra de enderecos* e cole aqui.

A URL vai ser algo como:
\`http://localhost:1455/auth/callback?code=...&state=...\`

O link expira em 10 minutos.`;
  }

  private async cmdExchangeGPTCallback(
    userPhone: string,
    rawUrl: string
  ): Promise<string> {
    const result = await this.openaiOAuth.exchangeCallback(userPhone, rawUrl);

    if (!result.success) {
      return result.error || "Erro ao conectar. Tente novamente com /conectar gpt.";
    }

    // Set the token in LLM service immediately
    const tokenData = await this.openaiOAuth.getValidToken(userPhone);
    if (tokenData) {
      this.llm.setOpenAIOAuthToken(tokenData.accessToken, tokenData.accountId);
    }

    return `*GPT conectado com sucesso!*

Conta: ${result.email || "conectada"}

O sub-agente agora pode usar o GPT Codex como fallback. O token e renovado automaticamente.`;
  }

  private async cmdDisconnectGPT(userPhone: string): Promise<string> {
    const status = await this.openaiOAuth.isConnected(userPhone);
    if (!status.connected) {
      return "Nao esta conectado ao GPT. Use /conectar gpt.";
    }

    await this.openaiOAuth.disconnect(userPhone);
    this.llm.setOpenAIOAuthToken(null);

    const active = this.llm.getActiveModel();
    if (active.provider === "openai") {
      this.llm.switchModel("gemini flash");
      return `GPT desconectado. Modelo trocado para *gemini flash*.`;
    }
    return "GPT desconectado.";
  }

  // ==================== MODEL COMMANDS ====================

  private async cmdShowModels(userPhone: string): Promise<string> {
    const claudeStatus = await this.claudeOAuth.isConnected(userPhone);
    const gptStatus = await this.openaiOAuth.isConnected(userPhone);

    return `*Modelos do ${config.agentName}:*

*Chat:* Gemini Flash (conversa direta)
*Sub-agente:* Claude Opus (primario) → GPT Codex → Gemini Pro (fallbacks)

*Conexoes OAuth:*
- Claude: ${claudeStatus.connected ? `conectado (${claudeStatus.email || ""})` : "/conectar claude"}
- GPT: ${gptStatus.connected ? `conectado (${gptStatus.email || ""})` : "/conectar gpt"}

_Claude e GPT ampliam as capacidades do sub-agente. O chat principal sempre usa Gemini Flash._`;
  }

  // ==================== MEMORY COMMANDS ====================

  private async cmdRemember(userPhone: string, input: string, numericUserId?: number, userRole: UserRole = "admin"): Promise<string> {
    const eqIndex = input.indexOf("=");
    if (eqIndex === -1) {
      return 'Formato: /lembrar [categoria:]chave = valor\nExemplo: /lembrar senhas:gmail = minha_senha123';
    }

    let keyPart = input.slice(0, eqIndex).trim();
    const value = input.slice(eqIndex + 1).trim();

    let category = "general";
    const colonIndex = keyPart.indexOf(":");
    if (colonIndex !== -1) {
      category = keyPart.slice(0, colonIndex).trim();
      keyPart = keyPart.slice(colonIndex + 1).trim();
    }

    if (!keyPart || !value) {
      return 'Formato: /lembrar [categoria:]chave = valor';
    }

    // Use RBAC-aware rememberV2 if numericUserId is available
    if (numericUserId) {
      const result = await this.memory.rememberV2(keyPart, value, category, numericUserId, userRole);
      if (result.blocked) {
        return `Nao foi possivel salvar: a memoria *${keyPart}* foi criada por um admin e nao pode ser sobrescrita.`;
      }
    } else {
      await this.memory.remember(userPhone, keyPart, value, category);
    }

    const sensitiveCategories = ["senhas", "passwords", "secrets", "tokens"];
    const warning = sensitiveCategories.includes(category.toLowerCase())
      ? "\n\n_Dica: para dados sensiveis, considere usar um gerenciador de senhas como Bitwarden._"
      : "";

    return `Lembrei! *${keyPart}* salvo na categoria *${category}*.${warning}`;
  }

  private async cmdForget(userPhone: string, key: string): Promise<string> {
    if (!key) {
      return "Formato: /esquecer <chave>\nExemplo: /esquecer senha do gmail";
    }

    // Use global forget (memories are global in RBAC model)
    const count = await this.memory.forgetGlobal(key);
    if (count > 0) {
      return `Pronto, esqueci "${key}". (${count} item(s) removido(s))`;
    }
    return `Nao encontrei nenhuma memoria com a chave "${key}".`;
  }

  private async cmdListMemories(userPhone: string, category?: string): Promise<string> {
    // Use global list (memories are global in RBAC model)
    const memories = await this.memory.listGlobalMemories(category);

    if (memories.length === 0) {
      return category
        ? `Nenhuma memoria na categoria "${category}".`
        : "Voce nao tem nenhuma memoria salva ainda.";
    }

    const grouped: Record<string, typeof memories> = {};
    for (const mem of memories) {
      if (!grouped[mem.category]) grouped[mem.category] = [];
      grouped[mem.category].push(mem);
    }

    let response = `*Suas memorias (${memories.length}):*\n`;
    for (const [cat, mems] of Object.entries(grouped)) {
      response += `\n*[${cat}]*\n`;
      for (const mem of mems) {
        const isSensitive = ["senhas", "passwords", "secrets", "tokens"].includes(cat.toLowerCase());
        const displayValue = isSensitive ? mem.value.slice(0, 3) + "***" : mem.value;
        response += `- ${mem.key}: ${displayValue}\n`;
      }
    }

    return response;
  }

  private async cmdSearch(userPhone: string, term: string): Promise<string> {
    if (!term) return "Formato: /buscar <termo>";

    // Use global recall (memories are global in RBAC model)
    const results = await this.memory.recallGlobal(term);
    if (results.length === 0) return `Nenhum resultado para "${term}".`;

    let response = `*Resultados para "${term}":*\n`;
    for (const mem of results) {
      response += `- [${mem.category}] ${mem.key}: ${mem.value}\n`;
    }
    return response;
  }

  private async cmdVectorSearch(userPhone: string, term: string): Promise<string> {
    if (!term) return "Formato: /vbuscar <termo>\nBusca semantica nas memorias.";
    if (!this.vectorMemory) return "Memoria semantica nao esta configurada.";

    // Use global vector search (memories are global in RBAC model)
    const results = await this.vectorMemory.searchGlobal(term, 10, 0.25);
    if (results.length === 0) return `Nenhum resultado semantico para "${term}".`;

    let response = `*Busca semantica para "${term}":*\n`;
    for (const mem of results) {
      const sim = mem.similarity ? ` (${(mem.similarity * 100).toFixed(0)}%)` : "";
      const preview = mem.content.length > 150 ? mem.content.substring(0, 150) + "..." : mem.content;
      response += `\n[${mem.category}]${sim}\n${preview}\n`;
    }
    return response;
  }

  // ==================== SUB-AGENT COMMANDS ====================

  private async cmdKillSubAgent(): Promise<string> {
    const live = this.sessionManager.getLiveSessions();
    if (live.length === 0) {
      return "Nenhum sub-agente ativo no momento.";
    }

    const count = await this.sessionManager.killAll();
    return `${count} sub-agente(s) encerrado(s) com sucesso!`;
  }

  // ==================== EDIT MODE COMMANDS ====================

  private async cmdStartEdit(userPhone: string, connectorName: string): Promise<string> {
    if (this.editSession) {
      return "Voce ja esta no modo de edicao. Use */exit* para sair ou */deploy* para aplicar.";
    }

    // Provider priority: Claude → OpenAI → Gemini Pro
    const claudeToken = await this.claudeOAuth.getValidToken(userPhone);
    let activeProvider: import("./subagent/edit-session.js").EditProvider = "claude";
    if (!claudeToken) {
      const gptToken = await this.openaiOAuth.getValidToken(userPhone);
      if (gptToken) {
        activeProvider = "openai";
      } else if (config.gemini?.apiKey) {
        activeProvider = "gemini";
      } else {
        return (
          "Nenhum modelo disponivel para o modo de edicao.\n\n" +
          "- */conectar claude* — recomendado (Claude Code com edicao autonoma)\n" +
          "- */conectar gpt* — alternativa (GPT-5.3 Codex com edicao de arquivos)\n" +
          "- Gemini Pro e usado automaticamente quando configurado no servidor"
        );
      }
    }

    // Auth expired callback: tries to refresh token, if fails sends OAuth link
    const authExpiredCb: AuthExpiredCallback = async () => {
      logger.info({ userPhone }, "Edit session auth expired — attempting refresh");

      // Try automatic refresh first
      const newToken = await this.claudeOAuth.getValidToken(userPhone);
      if (newToken) {
        // Refresh worked — re-inject into container
        let refreshToken: string | undefined;
        try {
          const { query: dbQuery } = await import("./memory/db.js");
          const r = await dbQuery(
            `SELECT refresh_token FROM oauth_tokens WHERE user_phone = $1 AND provider = 'claude' AND is_active = TRUE`,
            [userPhone]
          );
          refreshToken = r.rows[0]?.refresh_token;
        } catch (_) { /* ignore */ }

        if (this.editSession) {
          await this.editSession.refreshCredentials(newToken, refreshToken);
        }
        return true;
      }

      // Refresh failed — need re-auth. Send OAuth link.
      const { authUrl } = this.claudeOAuth.startAuth();
      await this.connectorManager.sendMessage(
        connectorName, userPhone,
        `*Token do Claude expirou!*\n\n` +
        `A sessao de edicao continua ativa — so preciso de um novo token.\n\n` +
        `1. Abra este link:\n${authUrl}\n\n` +
        `2. Cole o codigo aqui (formato \`codigo#state\`).\n\n` +
        `Apos colar, vou retomar de onde parei automaticamente.`
      );
      return false;
    };

    // Proactive token refresh callback — called before each Claude invocation
    const getFreshTokenCb: GetFreshTokenCallback = async () => {
      const token = await this.claudeOAuth.getValidToken(userPhone);
      if (!token) return null;

      let refreshToken: string | undefined;
      try {
        const { query: dbQuery } = await import("./memory/db.js");
        const r = await dbQuery(
          `SELECT refresh_token FROM oauth_tokens WHERE user_phone = $1 AND provider = 'claude' AND is_active = TRUE`,
          [userPhone]
        );
        refreshToken = r.rows[0]?.refresh_token;
      } catch (_) { /* ignore */ }

      return { accessToken: token, refreshToken };
    };

    // Persists assistant messages from Claude Code into session_messages table so they
    // survive F5 reloads. Uses this.editSession?.id (set before sendPrompt/sendContinue).
    // Note: must NOT go to the main conversations table — edit history is isolated.
    const saveHistoryCb: SaveHistoryFn = async (text: string, type: "text" | "tool_use" = "text") => {
      const sid = this.editSession?.id;
      if (!sid) return;
      try {
        const { query: dbSave } = await import("./memory/db.js");
        await dbSave(
          `INSERT INTO session_messages (session_id, role, content, message_type) VALUES ($1, $2, $3, $4)`,
          [sid, "assistant", text, type]
        );
      } catch (err) {
        logger.warn({ err }, "Failed to save edit session assistant message");
      }
    };

    // Clean up agent state when the edit session closes (deploy success or /exit from within session)
    const onCloseCb = () => {
      // Delete persisted messages for this edit session from DB
      const sid = this.editSession?.id;
      if (sid) {
        import("./memory/db.js").then(({ query: dbDel }) => {
          dbDel(`DELETE FROM session_messages WHERE session_id = $1`, [sid]).catch(() => {});
        }).catch(() => {});
      }
      this.editSession = null;
      this.editFirstPromptSent = false;
      this.editUserPhone = null;
    };

    const session = new EditSession(
      this.connectorManager,
      connectorName,
      userPhone,
      authExpiredCb,
      getFreshTokenCb,
      saveHistoryCb,
      onCloseCb,
      this.memory,
      activeProvider,
    );

    // Build env for the container — inject provider credentials based on active provider
    const env: Record<string, string> = {};

    // Gemini is always available as last resort
    if (config.gemini?.apiKey) env.GEMINI_API_KEY = config.gemini.apiKey;

    if (activeProvider === "claude" && claudeToken) {
      // Claude OAuth credentials
      env.CLAUDE_CODE_OAUTH_TOKEN = claudeToken;
      try {
        const { query } = await import("./memory/db.js");
        const result = await query(
          `SELECT refresh_token FROM oauth_tokens WHERE user_phone = $1 AND provider = 'claude' AND is_active = TRUE`,
          [userPhone]
        );
        if (result.rows[0]?.refresh_token) {
          env.CLAUDE_REFRESH_TOKEN = result.rows[0].refresh_token;
        }
      } catch (_) { /* ignore */ }
    } else if (activeProvider === "openai") {
      // OpenAI credentials (OAuth token or API key)
      const gptToken = await this.openaiOAuth.getValidToken(userPhone);
      if (gptToken) {
        env.OPENAI_ACCESS_TOKEN = gptToken.accessToken;
        if (gptToken.accountId) env.OPENAI_ACCOUNT_ID = gptToken.accountId;
      } else if (config.openai?.apiKey) {
        env.OPENAI_API_KEY = config.openai.apiKey;
      }
    }
    // For "gemini" provider: GEMINI_API_KEY already set above

    // Set this.editSession BEFORE start() so that saveHistoryCb (which reads
    // this.editSession?.id) can persist the welcome message to session_messages.
    // If start() throws, we reset the state in the catch block.
    this.editSession = session;
    this.editFirstPromptSent = false;
    this.editUserPhone = userPhone;
    try {
      await session.start(env);
      return ""; // Welcome message is sent by EditSession.start()
    } catch (err) {
      this.editSession = null;
      this.editFirstPromptSent = false;
      this.editUserPhone = null;
      logger.error({ err }, "Failed to start edit session");
      return `Erro ao iniciar modo de edicao: ${(err as Error).message}`;
    }
  }

  /**
   * Transcribe an audio MediaAttachment using Gemini.
   * Falls back to an error string if Gemini is unavailable or fails.
   */
  private async transcribeAudioWithGemini(media: MediaAttachment): Promise<string> {
    try {
      const gemini = new GeminiProvider();
      if (!gemini.isAvailable()) {
        return "[Gemini indisponível para transcrição]";
      }
      const result = await gemini.chat([
        { role: "user", content: "Transcreva este áudio. Retorne APENAS o texto falado, sem prefixo, sem aspas, sem explicacao.", media },
      ]);
      return result.content.trim();
    } catch (err) {
      logger.error({ err }, "Audio transcription via Gemini failed");
      return "[erro ao transcrever áudio]";
    }
  }

  private async cmdExitEdit(): Promise<string> {
    if (!this.editSession) {
      return "Voce nao esta no modo de edicao.";
    }

    await this.editSession.close();
    this.editSession = null;
    this.editFirstPromptSent = false;
    this.editUserPhone = null;
    return "*Modo de edicao encerrado.* Todas as mudancas foram descartadas.";
  }

  private async cmdDeploy(): Promise<string> {
    if (!this.editSession) {
      return "Voce nao esta no modo de edicao.";
    }

    if (this.editSession.getState() === "deploying") {
      return "Deploy ja esta em andamento...";
    }

    // Deploy runs async — it'll send progress updates via the callback
    this.editSession.deploy().catch((err) => {
      logger.error({ err }, "Deploy failed");
    });

    return ""; // Progress messages come from deploy pipeline
  }

  private async cmdPublish(repo?: string): Promise<string> {
    if (!this.editSession) {
      return "Voce nao esta no modo de edicao.";
    }

    if (this.editSession.getState() === "deploying" || this.editSession.getState() === "publishing") {
      return "Deploy/publish ja esta em andamento...";
    }

    // Publish runs async — it'll send progress updates via the callback
    this.editSession.publish(repo).catch((err) => {
      logger.error({ err }, "Publish failed");
    });

    return ""; // Progress messages come from publish pipeline
  }

  // ==================== INFO COMMANDS ====================

  private async cmdHelp(userPhone: string): Promise<string> {
    const vectorStatus = this.vectorMemory ? "ativa" : "desativada";

    const claudeStatus = await this.claudeOAuth.isConnected(userPhone);
    const gptStatus = await this.openaiOAuth.isConnected(userPhone);

    const claudeInfo = claudeStatus.connected ? `Conectado (${claudeStatus.email || ""})` : "desconectado";
    const gptInfo = gptStatus.connected ? `Conectado (${gptStatus.email || ""})` : "desconectado";

    return `*${config.agentName} - Comandos:*

*Memoria:*
/lembrar [cat:]chave = valor
/esquecer <chave>
/esquecer_tudo
/memorias [categoria]
/buscar <termo>
/vbuscar <termo> (semantica, ${vectorStatus})

*Conversa:*
/limpar - limpa historico
/modelo - mostra modelos e conexoes
/matar - encerra sub-agente ativo
/status - info do sistema
/ajuda - esta mensagem

*Conexoes OAuth:*
/conectar claude — ${claudeInfo}
/conectar gpt — ${gptInfo}
/desconectar claude | gpt

*Auto-edicao:*
/edit - entra no modo de edicao (editar codigo do ${config.agentName})
/exit - sai do modo de edicao (descarta mudancas)
/deploy - aplica mudancas com pipeline seguro
/publish [usuario/repo] - deploy + push para GitHub

*Modelos:*
Chat: Gemini Flash | Sub-agente: Claude → GPT → Gemini Pro

*Dica:* Voce tambem pode pedir naturalmente:
"Lembra que meu email e x@y.com"`;
  }

  private async cmdStatus(userPhone: string, numericUserId?: number): Promise<string> {
    // Use global memory list (memories are global in RBAC model)
    const memories = await this.memory.listGlobalMemories();
    const history = numericUserId
      ? await this.memory.getConversationHistoryByUserId(numericUserId)
      : await this.memory.getConversationHistory(userPhone);

    let vectorInfo = "desativada";
    let diskInfo = "";
    if (this.vectorMemory) {
      try {
        const totalCount = await this.vectorMemory.countAll();
        const dbSizeBytes = await this.vectorMemory.getDatabaseSizeBytes();
        const dbSizeMB = (dbSizeBytes / 1024 / 1024).toFixed(1);
        const maxGB = config.vectorDbMaxSizeGb;
        const usagePercent = ((dbSizeBytes / (maxGB * 1024 * 1024 * 1024)) * 100).toFixed(1);
        vectorInfo = `${totalCount} total`;
        diskInfo = `\n- Disco pgvector: ${dbSizeMB} MB / ${maxGB} GB (${usagePercent}%)`;
      } catch {
        vectorInfo = "erro de conexao";
      }
    }

    const claudeStatus = await this.claudeOAuth.isConnected(userPhone);
    const gptStatus = await this.openaiOAuth.isConnected(userPhone);

    const claudeInfo = claudeStatus.connected
      ? `Conectado (${claudeStatus.email || ""})`
      : "Desconectado";
    const gptInfo = gptStatus.connected
      ? `Conectado (${gptStatus.email || ""})`
      : "Desconectado";

    // Sub-agent status
    const liveSessions = this.sessionManager.getLiveSessions();
    let subAgentInfo = "nenhum";
    if (liveSessions.length > 0) {
      subAgentInfo = liveSessions
        .map((s) => {
          const elapsed = Math.round((Date.now() - s.createdAt) / 1000);
          return `sub-agente (${s.state}) ${elapsed}s`;
        })
        .join(", ");
    }

    const editInfo = this.editSession
      ? `ativo (${this.editSession.getState()})`
      : "inativo";

    // Connector status
    const connectors = this.connectorManager.getAll();
    const connectorInfo = connectors.map((c) => c.name).join(", ") || "nenhum";

    return `*Status do ${config.agentName}:*
- Chat: Gemini Flash (conversa direta)
- Sub-agente: Claude Opus → GPT Codex → Gemini Pro (fallbacks)
- Claude OAuth: ${claudeInfo}
- GPT OAuth: ${gptInfo}
- Sub-agentes: ${subAgentInfo}
- Modo edicao: ${editInfo}
- Conectores: ${connectorInfo}
- Memorias: ${memories.length} estruturadas
- Mem. semanticas: ${vectorInfo}${diskInfo}
- Historico: ${history.length} msgs (max ${config.conversationHistoryLimit})`;
  }

  // ==================== AUTO-EXTRACTION ====================

  private async buildSemanticContext(userPhone: string, queryText: string, userRole: UserRole = "admin"): Promise<string> {
    if (!this.vectorMemory) return "";

    try {
      // RBAC: Use global search (no user filter) with creator info
      const results = await this.vectorMemory.searchGlobal(queryText, 5, 0.35);
      if (results.length === 0) {
        // Fallback to legacy per-user search if no global results
        const legacyResults = await this.vectorMemory.search(userPhone, queryText, 5, 0.35);
        if (legacyResults.length === 0) return "";

        let context = "\n--- MEMORIAS SEMANTICAS (relevantes ao contexto) ---\n";
        for (const mem of legacyResults) {
          const sim = mem.similarity ? ` (${(mem.similarity * 100).toFixed(0)}% relevante)` : "";
          context += `- [${mem.category}] ${mem.content}${sim}\n`;
        }
        context += "--- FIM DAS MEMORIAS SEMANTICAS ---\n";
        return context;
      }

      let context = "\n--- MEMORIAS SEMANTICAS (relevantes ao contexto) ---\n";
      for (const mem of results) {
        const sim = mem.similarity ? ` (${(mem.similarity * 100).toFixed(0)}% relevante)` : "";
        const creator = mem.creator_role ? `, criado por: ${mem.creator_role}` : "";
        context += `- [${mem.category}${creator}] ${mem.content}${sim}\n`;
      }
      context += "--- FIM DAS MEMORIAS SEMANTICAS ---\n";
      if (results.length > 0) {
        context += "Nota: quando houver conflito entre memorias semanticas, priorize as criadas pelo administrador.\n";
      }

      return context;
    } catch (err) {
      logger.warn({ err }, "Failed to search vector memories");
      return "";
    }
  }

  private async autoEmbedConversation(
    userPhone: string,
    userMessage: string,
    assistantResponse: string,
    numericUserId?: number
  ): Promise<void> {
    if (!this.vectorMemory) return;

    const trivialPatterns = [
      /^(oi|ola|hey|hi|hello|e ai|fala|salve|bom dia|boa tarde|boa noite)\b/i,
      /^(ok|sim|nao|valeu|obrigado|brigado|thanks|blz|beleza|show|top)\b/i,
      /^\//,
    ];

    const isUserTrivial =
      userMessage.length < 15 ||
      trivialPatterns.some((p) => p.test(userMessage.trim()));

    if (isUserTrivial) return;

    const content = `Pergunta: ${userMessage.substring(0, 300)}\nResposta: ${assistantResponse.substring(0, 500)}`;

    try {
      // RBAC: Use global storage with created_by tracking
      await this.vectorMemory.storeGlobal(content, "conversation", "auto", {
        user_message: userMessage.substring(0, 200),
        timestamp: new Date().toISOString(),
      }, numericUserId);
    } catch (err) {
      logger.warn({ err }, "Failed to embed conversation");
    }
  }

  private async extractAndSaveMemories(
    userPhone: string,
    userMessage: string,
    assistantResponse: string,
    userRole: UserRole = "admin",
    numericUserId?: number
  ): Promise<void> {
    // Quick regex patterns for CREDENTIAL cases only.
    // Personal data (name, email, city, etc.) is handled by the LLM extraction
    // and stored in users.profile — NOT in the memories table.
    const credentialPatterns = [
      { regex: /(?:minha )?senha (?:do|da|de)\s+(\S+)\s+(?:e|é)\s+(.+)/i, category: "senhas", key: null as string | null },
    ];

    for (const pattern of credentialPatterns) {
      const match = userMessage.match(pattern.regex);
      if (match) {
        try {
          if (pattern.category === "senhas" && match[1] && match[2]) {
            if (numericUserId) {
              await this.memory.rememberV2(match[1].trim(), match[2].trim(), "senhas", numericUserId, userRole);
            } else {
              await this.memory.remember(userPhone, match[1].trim(), match[2].trim(), "senhas");
            }
          }
        } catch (err) {
          logger.warn({ err, pattern: pattern.regex.source }, "Failed to auto-save memory");
        }
      }
    }

    // NOTE: Auto-forget via regex was removed (was too greedy — matched casual
    // messages like "remove esse erro" and deleted memories). Memory deletion
    // now only happens through the explicit /esquecer command.

    // LLM-based extraction: if the assistant confirmed saving something,
    // use Gemini to extract structured data and persist to memories table
    const saveConfirmRegex = /salv[eoai]|guardei|guardad[oa]|lembr[eoai]|armazen[eoai]|armazenad[oa]|registr[eoai]|registrad[oa]|anotei|anotad[oa]|memori[sz]/i;
    const matched = assistantResponse.match(saveConfirmRegex);
    logger.info(
      { matched: !!matched, matchStr: matched?.[0], responseSnippet: assistantResponse.substring(0, 100) },
      "extractAndSaveMemories: LLM extraction trigger check"
    );
    // Also trigger if user message looks like it contains credentials to save
    const userCredRegex = /(?:salva|guarda|lembra|armazena|registra|anota)\s.*(?:senha|credencia|login|usuario|token|e-?mail|chave)/i;
    const userHasCred = userMessage.match(userCredRegex);

    if (matched || userHasCred) {
      logger.info(
        { trigger: matched ? "assistant_confirmed" : "user_credential_intent", userHasCred: !!userHasCred },
        "extractAndSaveMemories: triggering LLM extraction"
      );
      this.llmExtractMemories(userPhone, userMessage, assistantResponse, userRole, numericUserId).catch((err) => {
        logger.warn({ err: err?.message || err }, "LLM memory extraction failed (outer catch)");
      });
    }
  }

  private isCredentialCategory(category: string): boolean {
    return ["credenciais", "senhas", "tokens", "passwords", "secrets"].includes(category.toLowerCase());
  }

  private isWeakCredentialValue(value: string): boolean {
    const lower = value.trim().toLowerCase();
    if (!lower) return true;
    const weak = new Set([
      "conta de usuario",
      "conta de usuário",
      "conta do usuario",
      "conta do usuário",
      "usuario",
      "usuário",
      "senha",
      "token",
      "chave",
      "chave do autenticador",
      "email",
      "e-mail",
      "login",
    ]);
    return weak.has(lower);
  }

  private extractCredentialField(text: string, pattern: RegExp): string | undefined {
    const match = text.match(pattern);
    if (!match?.[1]) return undefined;
    const value = match[1].trim().replace(/[.,;]+$/, "");
    return value || undefined;
  }

  private parseCredentialFields(text: string): {
    usuario?: string;
    senha?: string;
    email?: string;
    chaveTotp?: string;
    token?: string;
  } {
    const emailMatch = text.match(/\b\S+@\S+\.\S+\b/);
    return {
      usuario: this.extractCredentialField(text, /(?:usu[aá]rio|login)\s*[:=]\s*([^,\n;]+)/i),
      senha: this.extractCredentialField(text, /(?:senha|password|pass)\s*[:=]\s*([^,\n;]+)/i),
      email: this.extractCredentialField(text, /(?:e-?mail)\s*[:=]\s*([^,\n;]+)/i) || emailMatch?.[0],
      chaveTotp: this.extractCredentialField(text, /(?:chave(?:\s+do\s+autenticador)?|totp|2fa)\s*[:=]\s*([^,\n;]+)/i),
      token: this.extractCredentialField(text, /token\s*[:=]\s*([^,\n;]+)/i),
    };
  }

  private mergeCredentialValues(existingValue: string, incomingValue: string): string {
    const existing = this.parseCredentialFields(existingValue);
    const incoming = this.parseCredentialFields(incomingValue);

    const pick = (oldVal?: string, newVal?: string): string | undefined => {
      if (newVal && !this.isWeakCredentialValue(newVal)) return newVal;
      if (oldVal && !this.isWeakCredentialValue(oldVal)) return oldVal;
      return newVal || oldVal;
    };

    const merged = {
      usuario: pick(existing.usuario, incoming.usuario),
      senha: pick(existing.senha, incoming.senha),
      email: pick(existing.email, incoming.email),
      chaveTotp: pick(existing.chaveTotp, incoming.chaveTotp),
      token: pick(existing.token, incoming.token),
    };

    const parts: string[] = [];
    if (merged.usuario) parts.push(`usuario: ${merged.usuario}`);
    if (merged.email) parts.push(`email: ${merged.email}`);
    if (merged.senha) parts.push(`senha: ${merged.senha}`);
    if (merged.chaveTotp) parts.push(`chave do autenticador: ${merged.chaveTotp}`);
    if (merged.token) parts.push(`token: ${merged.token}`);

    if (parts.length > 0) return parts.join(", ");

    // Fallback: never let a low-information extraction overwrite richer data.
    if (this.isWeakCredentialValue(incomingValue) && !this.isWeakCredentialValue(existingValue)) {
      return existingValue;
    }
    return incomingValue.length >= existingValue.length ? incomingValue : existingValue;
  }

  /**
   * Use Gemini Flash to extract structured key-value memories from a conversation turn.
   * Only called when the assistant confirmed it saved/remembered something.
   */
  private async llmExtractMemories(
    userPhone: string,
    userMessage: string,
    assistantResponse: string,
    userRole: UserRole = "admin",
    numericUserId?: number
  ): Promise<void> {
    const extractPrompt = `Extraia informacoes estruturadas da mensagem do usuario para salvar em memoria.

MENSAGEM DO USUARIO:
${userMessage.substring(0, 1000)}

RESPOSTA DO ASSISTENTE:
${assistantResponse.substring(0, 500)}

Retorne APENAS linhas no formato: CATEGORIA|CHAVE|VALOR
Categorias validas: credenciais, senhas, preferencias, notas, conhecimento

IMPORTANTE: Informacoes pessoais do usuario (nome, email pessoal, telefone, cidade, trabalho) NAO devem ser extraidas como memorias. Elas sao gerenciadas separadamente no perfil do usuario.

Regras:
- Cada credencial/senha deve ser uma linha separada
- Para credenciais multi-campo (usuario, senha, email, token, chave), agrupe tudo em um UNICO valor
- A CHAVE deve ser o nome do servico/conta (ex: "github", "outlook", "gmail")
- O VALOR deve conter todos os campos relevantes
- Use a categoria "conhecimento" para fatos gerais que o usuario ensinou

Exemplos de entrada/saida:
- "salva credencial do github: user:joao senha:123" → credenciais|github|usuario: joao, senha: 123
- "meu email outlook é joao@outlook.com e senha abc123" → credenciais|outlook|email: joao@outlook.com, senha: abc123
- "lembra que prefiro dark mode" → preferencias|dark mode|prefere dark mode
- "a capital da Australia é Canberra" → conhecimento|capital da australia|Canberra

Se nao houver nada para extrair, retorne VAZIO (apenas essa palavra).
Retorne APENAS as linhas de extracao, nada mais.`;

    try {
      logger.info({ userPhone, msgSnippet: userMessage.substring(0, 80) }, "llmExtractMemories: calling Gemini for extraction");
      const result = await this.llm.chat(
        [{ role: "user", content: extractPrompt }],
        undefined
      );
      const text = result.content.trim();
      logger.info({ text: text.substring(0, 200) }, "llmExtractMemories: Gemini raw response");

      if (text === "VAZIO" || !text) {
        logger.info("llmExtractMemories: no data to extract (VAZIO)");
        return;
      }

      const lines = text.split("\n").filter((l) => l.includes("|"));
      logger.info({ lineCount: lines.length }, "llmExtractMemories: parsed extraction lines");

      for (const line of lines) {
        const parts = line.split("|").map((p) => p.trim());
        if (parts.length < 3) {
          logger.warn({ line }, "llmExtractMemories: skipping malformed line");
          continue;
        }
        const [category, key, ...valueParts] = parts;
        const value = valueParts.join("|"); // in case value contains |
        if (!key || !value) continue;

        const normalizedCategory = category.toLowerCase();
        const normalizedKey = key.toLowerCase();
        let finalValue = value;

        // Protect credential memories from being degraded by partial extractions.
        if (this.isCredentialCategory(normalizedCategory)) {
          // Use global recall for RBAC-aware memory lookups
          const existing = (await this.memory.recallGlobal(normalizedKey)).find(
            (m) => m.key.toLowerCase() === normalizedKey && m.category.toLowerCase() === normalizedCategory
          );

          if (existing?.value) {
            finalValue = this.mergeCredentialValues(existing.value, value);
            if (finalValue === existing.value && value !== existing.value) {
              logger.info(
                { userPhone, key: normalizedKey },
                "Preserved richer existing credential value"
              );
            }
          }
        }

        // RBAC: Use rememberV2 with hierarchy enforcement when numericUserId is available
        if (numericUserId) {
          const result = await this.memory.rememberV2(normalizedKey, finalValue, normalizedCategory, numericUserId, userRole);
          if (result.blocked) {
            logger.info(
              { userPhone, category: normalizedCategory, key: normalizedKey, existingValue: result.existingValue?.substring(0, 50) },
              "LLM extraction blocked by hierarchy"
            );
            continue;
          }
        } else {
          // Legacy fallback — no RBAC checks
          await this.memory.remember(userPhone, normalizedKey, finalValue, normalizedCategory);
        }
        logger.info(
          { userPhone, category: normalizedCategory, key: normalizedKey, valueLen: finalValue.length },
          "LLM extracted and saved memory"
        );
      }
    } catch (err: any) {
      logger.warn({ err: err?.message || err, stack: err?.stack?.substring(0, 300) }, "LLM memory extraction failed (inner catch)");
    }
  }

  // ==================== WEB UI BRIDGE ====================

  /**
   * Create a WebAgentBridge for the web connector to access
   * sessions, edit mode, and other agent internals.
   */
  createWebBridge(webConnector: WebConnector): WebAgentBridge {
    // Wire session message callback so sub-agent messages go to public session pages
    this.sessionManager.setSessionMessageCallback((sessionId, role, text) => {
      webConnector.broadcastToSessionSubscribers(sessionId, role, text);
    });

    const bridge: WebAgentBridge = {
      getSessionsForUI: () => {
        const sessions = this.sessionManager.getLiveSessions();
        return sessions.map((s) => ({
          id: s.id,
          state: s.state,
          taskDescription: s.taskDescription,
          createdAt: s.createdAt,
        }));
      },

      killSession: async (sessionId: string) => {
        await this.sessionManager.killSession(sessionId);
      },

      sendToSession: async (sessionId: string, message: string) => {
        await this.sessionManager.sendToSession(sessionId, message);
      },

      isEditModeActive: () => {
        return this.editSession !== null;
      },

      startEditMode: async (connectorName: string, userId: string) => {
        const result = await this.cmdStartEdit(userId, connectorName);
        if (result === "") {
          // Success — notify web clients
          webConnector.notifyEditMode(true);
          return "";
        }
        return result; // Error message
      },

      stopEditMode: async () => {
        const result = await this.cmdExitEdit();
        if (result.startsWith("*Modo de edicao encerrado.*")) {
          return "";
        }
        return result;
      },

      getConversationHistory: async (userPhone: string, limit?: number, numericUserId?: number) => {
        // Use user_id-based history if available (RBAC), otherwise fallback to phone-based
        if (numericUserId) {
          return this.memory.getConversationHistoryByUserId(numericUserId, limit);
        }
        return this.memory.getConversationHistory(userPhone, limit);
      },

      getSessionHistory: async (sessionId: string) => {
        return this.sessionManager.getSessionHistory(sessionId);
      },

      getEditHistory: async (): Promise<Array<{ role: string; content: string; created_at: string; message_type?: string; audio_url?: string; image_urls?: string[]; file_infos?: Array<{ url: string; name: string; mimeType: string }> }>> => {
        if (!this.editSession) return [];
        try {
          const { query: dbQuery } = await import("./memory/db.js");
          const result = await dbQuery(
            `SELECT role, content, created_at, message_type, audio_url, image_urls, file_infos FROM session_messages WHERE session_id = $1 ORDER BY created_at ASC`,
            [this.editSession.id]
          );
          return result.rows.map((row: any) => {
            const msg: { role: string; content: string; created_at: string; message_type?: string; audio_url?: string; image_urls?: string[]; file_infos?: Array<{ url: string; name: string; mimeType: string }> } = {
              role: row.role,
              content: row.content,
              created_at: row.created_at,
            };
            if (row.message_type) msg.message_type = row.message_type;
            if (row.audio_url) msg.audio_url = row.audio_url;
            if (row.image_urls) {
              try {
                const parsed = JSON.parse(row.image_urls);
                msg.image_urls = Array.isArray(parsed) ? parsed : [row.image_urls];
              } catch {
                msg.image_urls = [row.image_urls];
              }
            }
            if (row.file_infos) {
              try {
                const parsed = JSON.parse(row.file_infos);
                msg.file_infos = Array.isArray(parsed) ? parsed : undefined;
              } catch {
                // Ignore malformed JSON
              }
            }
            return msg;
          });
        } catch (err) {
          logger.warn({ err }, "Failed to load edit session history");
          return [];
        }
      },

      sendTranscription: (audioUrl: string, transcription: string) => {
        webConnector.sendTranscription(audioUrl, transcription);
      },

      clearConversation: async (userPhone: string, numericUserId?: number) => {
        // Use user_id-based clear if available (RBAC), otherwise fallback to phone-based
        if (numericUserId) {
          await this.memory.clearConversationByUserId(numericUserId);
        } else {
          await this.memory.clearConversation(userPhone);
        }
      },

      createBlankSubAgentSession: async (connectorName: string, userId: string): Promise<string> => {
        // Build env vars for the sub-agent container (same as delegateToSubAgent)
        const env: Record<string, string> = {};

        const claudeToken = await this.claudeOAuth.getValidToken(userId);
        if (claudeToken) {
          env.ANTHROPIC_ACCESS_TOKEN = claudeToken;
        } else if (config.anthropic?.apiKey) {
          env.ANTHROPIC_API_KEY = config.anthropic.apiKey;
        }

        const openaiToken = await this.openaiOAuth.getValidToken(userId);
        if (openaiToken) {
          env.OPENAI_ACCESS_TOKEN = openaiToken.accessToken;
          if (openaiToken.accountId) env.OPENAI_ACCOUNT_ID = openaiToken.accountId;
        } else if (config.openai?.apiKey) {
          env.OPENAI_API_KEY = config.openai.apiKey;
        }

        if (config.gemini?.apiKey) env.GEMINI_API_KEY = config.gemini.apiKey;
        if (config.databaseUrl) env.DATABASE_URL = config.databaseUrl;
        if (config.vectorDatabaseUrl) env.PGVECTOR_URL = config.vectorDatabaseUrl;

        let session;
        try {
          // Empty taskDescription → session starts in "waiting_user" state
          session = await this.sessionManager.createSession("", connectorName, userId, {}, env);
        } catch (err) {
          logger.error({ err }, "Failed to create blank sub-agent session");
          throw err;
        }

        const rickName = getSessionRickName(session.id);
        const baseUrl = config.webBaseUrl || `https://rick.barroso.tec.br`;
        const sessionUrl = `${baseUrl}/s/${session.id}`;

        const ack = `Sessao *${rickName}* aberta e aguardando sua primeira tarefa:\n${sessionUrl}`;
        await this.memory.saveMessage(userId, "assistant", ack);
        return ack;
      },
    };

    this.webBridge = bridge;
    return bridge;
  }
}
