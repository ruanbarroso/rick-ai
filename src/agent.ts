// Rick AI - Agente pessoal de IA (v3)
import { LLMService } from "./llm/llm-service.js";
import { LLMMessage, MediaAttachment } from "./llm/types.js";
import { GeminiProvider } from "./llm/providers/gemini.js";
import { MemoryService } from "./memory/memory-service.js";
import { VectorMemoryService } from "./memory/vector-memory-service.js";
import { ClaudeOAuthService } from "./auth/claude-oauth.js";
import { OpenAIOAuthService } from "./auth/openai-oauth.js";
import { claudeOAuthService, openaiOAuthService } from "./auth/oauth-singleton.js";
import { SessionManager, getSessionVariantName, getUserSessionsToken } from "./subagent/session-manager.js";


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
   * Per-user message processing lock. Serializes handleMessage calls to prevent
   * race conditions (e.g., two messages arriving while one is being classified).
   * Key: userPhone, Value: promise chain for that user.
   */
  private messageQueue = new Map<string, Promise<string>>();

  /**
   * Per-user AbortController for cancelling in-flight LLM requests.
   * Key: userPhone, Value: { controller, generation }
   * The generation counter prevents race conditions when a new message arrives
   * while the previous one is being cancelled.
   */
  private userAbortControllers = new Map<string, { controller: AbortController; generation: number }>();

  /**
   * Monotonically increasing generation counter per user.
   * Incremented each time a new message arrives for a user.
   */
  private userGenerations = new Map<string, number>();

  /** Reference to web bridge for sending transcription events etc. */
  private webBridge: WebAgentBridge | null = null;
  /** Callback for broadcasting main-session messages to public viewers */
  private mainSessionCallback: ((userId: number, role: string, text: string, messageType?: string, connectorName?: string, mediaInfo?: { audioUrl?: string; imageUrls?: string[]; fileInfos?: Array<{ url: string; name: string; mimeType: string }> }) => void) | null = null;
  /** Callback for broadcasting typing state to public main-session viewers */
  private mainTypingCallback: ((userId: number, composing: boolean) => void) | null = null;

  /** Notify main session viewers of a new message (fire-and-forget). */
  private notifyMainViewers(userId: number, role: string, text: string, messageType?: string, connectorName?: string, mediaInfo?: { audioUrl?: string; imageUrls?: string[]; fileInfos?: Array<{ url: string; name: string; mimeType: string }> }): void {
    if (this.mainSessionCallback) {
      try { this.mainSessionCallback(userId, role, text, messageType, connectorName, mediaInfo); } catch {}
    }
  }

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
    this.claudeOAuth = claudeOAuthService;
    this.openaiOAuth = openaiOAuthService;
    this.sessionManager = new SessionManager(connectorManager, memory);
  }

  /**
   * Interrupt any in-flight processing for a specific user.
   * Called when user sends a new message while processing, or clicks Stop button.
   * Returns true if there was something to interrupt.
   */
  interruptUser(userId: string): boolean {
    const state = this.userAbortControllers.get(userId);
    if (state) {
      // Increment generation so the in-flight response gets discarded.
      // This is critical for the Stop button case where no new message is sent.
      const newGen = (this.userGenerations.get(userId) ?? 0) + 1;
      this.userGenerations.set(userId, newGen);
      
      logger.info({ userId, oldGen: state.generation, newGen }, "Interrupting user processing");
      state.controller.abort();
      this.userAbortControllers.delete(userId);
      return true;
    }
    return false;
  }

  /**
   * Check if a user currently has processing in flight.
   */
  isUserProcessing(userId: string): boolean {
    return this.userAbortControllers.has(userId);
  }

  /**
   * Recover orphaned sub-agent containers that survived a restart.
   * Call once after all connectors are registered and started.
   */
  async recoverOrphanedSessions(): Promise<number> {
    return this.sessionManager.recoverSessions();
  }

  warmupSubagentImage(): void {
    this.sessionManager.warmupSubagentImage();
  }

  async expireStaleSessions(): Promise<number> {
    return this.sessionManager.expireStaleDoneSessions();
  }

  async killSession(sessionId: string): Promise<void> {
    return this.sessionManager.killSession(sessionId);
  }

  /**
   * Public entry point — serializes per user to prevent race conditions.
   * Two messages from the same user are processed sequentially, never concurrently.
   * Called by ConnectorManager when any connector receives a message.
   * 
   * When multiple messages arrive quickly, only the LAST one generates a response.
   * Earlier messages are saved to history but their LLM responses are discarded.
   * This is achieved by checking the generation number before sending any response.
   */
  async handleMessage(msg: IncomingMessage): Promise<string> {
    const { userId } = msg;

    // Increment generation counter. Each message gets a unique generation number.
    // Only the message with the HIGHEST generation number will send a response.
    const generation = (this.userGenerations.get(userId) ?? 0) + 1;
    this.userGenerations.set(userId, generation);

    logger.info({ userId, generation, text: msg.text?.substring(0, 30) }, "handleMessage: new message arrived");

    // Create AbortController for this request (used to cancel LLM calls)
    const abortController = new AbortController();
    this.userAbortControllers.set(userId, { controller: abortController, generation });

    const prev = this.messageQueue.get(userId) ?? Promise.resolve("");
    const next = prev
      .catch(() => {}) // don't let a failed message block the queue
      .then(() => this.handleMessageInternal(msg, abortController.signal, generation));
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

  /**
   * Check if this generation is still the latest for the user.
   * Returns true if a newer message has arrived and we should skip sending response.
   */
  private isSuperseded(userId: string, generation: number): boolean {
    const currentGen = this.userGenerations.get(userId) ?? 0;
    return generation < currentGen;
  }

  private async handleMessageInternal(msg: IncomingMessage, signal: AbortSignal, generation: number): Promise<string> {
    const { connectorName, userId: userPhone, userName, text: rawText, media, imageMedias, quotedText, audioUrl, imageUrls, fileInfos } = msg;
    const numericUserId = msg.numericUserId;
    // Web UI always sends messages as the admin user (the only Web UI user).
    // For connectors (WhatsApp), userRole comes from resolveUser() and can be null (pending).
    const userRole: UserRole = msg.userRole !== undefined ? msg.userRole : "admin";

    const currentGen = this.userGenerations.get(userPhone) ?? 0;
    logger.info({ userPhone, generation, currentGen, text: rawText?.substring(0, 30) }, "handleMessageInternal: starting");

    // Get or create user — always yields a numeric user.id for DB operations.
    // When RBAC is active (numericUserId available), the user was already resolved by the connector.
    // Otherwise, fall back to legacy phone-based lookup.
    const user = numericUserId
      ? { id: numericUserId, phone: userPhone, displayName: userName || null }
      : await this.memory.getOrCreateUser(userPhone, userName);

    // Save user message EARLY so it appears in history even if request is superseded.
    // This ensures subsequent messages have full context of what user said.
    await this.memory.saveMessageByUserId(user.id, "user", rawText, undefined, undefined, audioUrl, imageUrls, undefined, fileInfos, connectorName);
    const userMediaInfo = (audioUrl || (imageUrls && imageUrls.length > 0) || (fileInfos && fileInfos.length > 0))
      ? { audioUrl, imageUrls, fileInfos } : undefined;
    this.notifyMainViewers(user.id, "user", rawText, "text", connectorName, userMediaInfo);

    // Check if superseded by newer message AFTER saving user message
    if (this.isSuperseded(userPhone, generation)) {
      logger.info({ userPhone, generation, currentGen: this.userGenerations.get(userPhone) }, "Superseded by newer message — skipping response");
      return "";
    }

    // If message is a reply to another message, prepend quoted context
    let fullText = rawText;
    if (quotedText) {
      fullText = `[Em resposta a: "${quotedText.substring(0, 300)}"]\n\n${rawText}`;
    }

    // ==================== AUDIO TRANSCRIPTION ====================
    // Audio messages are transcribed here so that the rest of the pipeline
    // (commands, classifier, sub-agent relay) treats them as normal text.
    // Without this, audio bypasses all routing and goes straight to simple chat,
    // which can cause hallucinations (e.g., claiming to delete emails it never touched).
    let routingMedia = media; // keep original for simple chat (image support)
    if (media?.mimeType.startsWith("audio/")) {
      const transcription = await this.transcribeAudioWithGemini(media);

      // Check if aborted during transcription
      if (signal.aborted) {
        logger.info({ userPhone }, "Request aborted during audio transcription — skipping response");
        return "";
      }

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

    // Check for implicit OAuth code pasting (not a slash command — just pattern detection)
    if (!routingMedia) {
      const oauthResult = await this.handleImplicitOAuth(fullText, user.id);
      if (oauthResult !== null) return oauthResult;
    }

    // If there's a pending delegation waiting for credentials, handle it
    if (this.pendingDelegation && !routingMedia) {
      return this.handlePendingCredential(userPhone, connectorName, fullText, user.id, userRole);
    }

    // Show typing indicator while processing (classification + LLM call can take several seconds)
    await this.connectorManager.setTyping(connectorName, userPhone, true);
    if (this.mainTypingCallback) try { this.mainTypingCallback(user.id, true); } catch {}
    try {
      // Keep OAuth tokens fresh — needed for sub-agent LLM fallback
      await this.ensureOAuthTokens(user.id);

      // Collect all images for potential sub-agent forwarding
      const allImageMedias: MediaAttachment[] = [];
      if (routingMedia && routingMedia.mimeType.startsWith("image/")) allImageMedias.push(routingMedia);
      if (imageMedias) {
        for (const img of imageMedias) {
          if (!allImageMedias.includes(img)) allImageMedias.push(img);
        }
      }

      // Auto-expire stale done sessions (> 30 min) to prevent them from
      // intercepting all WhatsApp messages indefinitely.
      await this.sessionManager.expireStaleDoneSessions();

      // If there are sessions with pending "done" polls FOR THIS USER, handle the 3 cases:
      // 1. Encerrar (explicit close words)
      // 2. Continuidade (adjust/fix on the same session)
      // 3. Novo pedido (different topic → nag to close first)
      // Skip this interception when the message comes from Web UI's main session
      // (sub-agents have their own dedicated panels there).
      const userHasDoneSessions = this.sessionManager.hasDoneSessionsForUser(userPhone);
      if (userHasDoneSessions && !msg.skipSubAgentRelay) {
        logger.info({ userPhone, userRole, doneSessions: this.sessionManager.getDoneSessionsForUser(userPhone).length }, "Routing to sub-agent relay (user has done sessions)");
        const relayResult = await this.handleSubAgentRelay(userPhone, connectorName, fullText, audioUrl, imageUrls, allImageMedias, fileInfos, user.id, signal);
        // null means the message is a SELF task that doesn't relate to the session — fall through to normal chat
        if (relayResult !== null) return relayResult;
        logger.info({ userPhone }, "Sub-agent relay returned null — falling through to normal classification");
      }

      // Classify the task — does it need a sub-agent?
      // Skip classification for roles that cannot invoke sub-agents (business)
      const canDelegate = canInvokeSubAgent(userRole);
      const classification = canDelegate ? await classifyTask(fullText, signal) : null;

      // Check if superseded by newer message after classification
      if (this.isSuperseded(userPhone, generation)) {
        logger.info({ userPhone, generation }, "Superseded after classification — skipping response");
        return "";
      }

      logger.info(
        { userPhone, userRole, canDelegate, classified: classification ? "DELEGATE" : "SELF", text: fullText.substring(0, 80) },
        "Task classification result"
      );

      // If a sub-agent is already running FOR THIS USER, only block new DELEGATE tasks.
      // SELF tasks (save memory, answer questions, etc.) are handled normally
      // by the main session, independently of any running sub-agent.
      const userRunningSessions = this.sessionManager.getRunningSessionsForUser(userPhone);
      if (userRunningSessions.length > 0) {
        if (classification) {
          logger.info({ userPhone, runningSessions: userRunningSessions.length }, "Blocking DELEGATE — sub-agent already running for user");
          return "O sub-agente ainda esta trabalhando... Aguarde um momento.";
        }
        // SELF task — fall through to handleSimpleChat below
        logger.info({ userPhone }, "SELF task while sub-agent running — handling via simple chat");
      } else if (classification) {
        logger.info({ userPhone, credentialHints: classification.credentialHints }, "Delegating to sub-agent");
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
          user.id
        );
      }

      // Simple chat — Gemini Flash handles directly (classifier said SELF or user can't delegate)
      logger.info({ userPhone, userRole }, "Handling via simple chat (no delegation)");
      // Combine all image media: routingMedia (first image or single image) + imageMedias (remaining)
      let allMedia: MediaAttachment | MediaAttachment[] | undefined = routingMedia;
      if (routingMedia && imageMedias && imageMedias.length > 0) {
        // If we have routingMedia, it is ALWAYS imageMedias[0].
        // imageMedias ALREADY contains all images. So we just use imageMedias directly.
        allMedia = imageMedias;
      } else if (!routingMedia && imageMedias && imageMedias.length > 0) {
        allMedia = imageMedias.length === 1 ? imageMedias[0] : imageMedias;
      }
      return this.handleSimpleChat(userPhone, user.displayName, fullText, allMedia, audioUrl, imageUrls, fileInfos, userRole, user.id, connectorName, signal, generation);
    } finally {
      // Clean up abort controller for this generation (only if it's still the current one)
      const currentState = this.userAbortControllers.get(userPhone);
      if (currentState && currentState.generation === generation) {
        this.userAbortControllers.delete(userPhone);
      }
      // Only turn off typing indicator if this is the latest generation.
      // Otherwise, a newer message is still processing and should keep the indicator on.
      if (!this.isSuperseded(userPhone, generation)) {
        await this.connectorManager.setTyping(connectorName, userPhone, false);
        if (this.mainTypingCallback) try { this.mainTypingCallback(user.id, false); } catch {}
      }
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
    userId?: number,
    connectorName?: string,
    signal?: AbortSignal,
    generation?: number
  ): Promise<string> {
    // RBAC: Use global memory context with role-based filtering
    const memoryContext = await this.memory.buildGlobalMemoryContext(userRole);
    const semanticContext = await this.buildSemanticContext(userId!, text, userRole);

    const history = await this.memory.getConversationHistoryByUserId(userId!);

    const systemPrompt = this.buildSystemPrompt(userName, memoryContext, semanticContext, userRole, true);

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

    // Note: User message is already saved in handleMessageInternal() before we get here.
    // This ensures aborted messages are also in the history for context.

    let response;
    try {
      response = await this.llm.chat(messages, systemPrompt, signal);
    } catch (err: any) {
      // Check if this was an abort (either AbortError or our custom abort message)
      if (err.name === "AbortError" || signal?.aborted || err.message?.includes("aborted")) {
        logger.info({ userPhone }, "LLM request aborted by user");
        return ""; // Return empty string — the new message will generate a response
      }
      logger.error({ userPhone, model: this.llm.getActiveModel().id, err: err.message }, "Gemini Flash failed — no fallback");
      return `Erro no Gemini: ${err.message?.substring(0, 200) || "erro desconhecido"}.\nTente novamente em alguns segundos.`;
    }

    // Final check: if superseded by newer message, discard this response
    // This is the KEY check that prevents multiple responses
    if (generation !== undefined && this.isSuperseded(userPhone, generation)) {
      logger.info({ userPhone, generation, currentGen: this.userGenerations.get(userPhone) }, "LLM completed but superseded — discarding response");
      return "";
    }

    response.content = response.content.trim();

    await this.memory.saveMessageByUserId(userId!, "assistant", response.content, response.model, response.tokensUsed, undefined, undefined, undefined, undefined, connectorName);
    this.notifyMainViewers(userId!, "agent", response.content, "text", connectorName);

    // RBAC: Only extract memories and embed if user role allows learning
    if (canLearn(userRole)) {
      await this.extractAndSaveMemories(userId!, text, response.content, userRole);

      this.autoEmbedConversation(userId!, text, response.content).catch(
        (err) => logger.warn({ err }, "Failed to auto-embed conversation")
      );
    }

    return response.content;
  }

  /**
   * Build the env vars for a sub-agent container (LLM credentials only).
   * DATABASE_URL and PGVECTOR_URL are intentionally omitted —
   * subagents access data via the read-only Agent API (/api/agent/*) with JWT auth.
   */

  /** Resolve a Claude OAuth token, falling back to admin (id=1) when the user has none. */
  private async resolveClaudeToken(userId: number): Promise<string | null> {
    const adminUserId = 1;
    const uids = userId === adminUserId ? [adminUserId] : [userId, adminUserId];
    for (const uid of uids) {
      const token = await this.claudeOAuth.getValidToken(uid);
      if (token) return token;
    }
    return null;
  }

  /** Resolve an OpenAI OAuth token, falling back to admin (id=1) when the user has none. */
  private async resolveOpenAIToken(userId: number): Promise<{ accessToken: string; accountId: string | null } | null> {
    const adminUserId = 1;
    const uids = userId === adminUserId ? [adminUserId] : [userId, adminUserId];
    for (const uid of uids) {
      const token = await this.openaiOAuth.getValidToken(uid);
      if (token) return token;
    }
    return null;
  }

  private async buildSubAgentEnv(userId: number): Promise<Record<string, string>> {
    const env: Record<string, string> = {};

    // Fetch Claude and OpenAI tokens (with admin fallback)
    const claudeToken = await this.resolveClaudeToken(userId);
    const openaiToken = await this.resolveOpenAIToken(userId);

    // Anthropic (Claude) — OAuth token first, then API key fallback
    if (claudeToken) {
      env.ANTHROPIC_ACCESS_TOKEN = claudeToken;
    } else if (config.anthropic?.apiKey) {
      env.ANTHROPIC_API_KEY = config.anthropic.apiKey;
    }

    // OpenAI (GPT) — OAuth token first, then API key fallback
    if (openaiToken) {
      env.OPENAI_ACCESS_TOKEN = openaiToken.accessToken;
      if (openaiToken.accountId) env.OPENAI_ACCOUNT_ID = openaiToken.accountId;
    } else if (config.openai?.apiKey) {
      env.OPENAI_API_KEY = config.openai.apiKey;
    }

    // Gemini — always from config
    if (config.gemini?.apiKey) env.GEMINI_API_KEY = config.gemini.apiKey;

    // GitHub — pass GITHUB_TOKEN so sub-agents can clone private repos
    if (process.env.GITHUB_TOKEN) env.GITHUB_TOKEN = process.env.GITHUB_TOKEN;

    // Agent name — so sub-agents use the correct name in messages
    env.AGENT_NAME = config.agentName;

    return env;
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
    userId?: number
  ): Promise<string> {
    if (!userId) {
      logger.error("delegateToSubAgent called without userId — aborting delegation");
      return "Erro interno: ID de usuário não resolvido para delegação.";
    }

    // Build env vars for the sub-agent container — LLM credentials only
    const env = await this.buildSubAgentEnv(userId);

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

    // Resolve credentials from memory for the hinted services.
    // Also check config-store env vars (e.g. GITHUB_TOKEN set via Web UI settings)
    // so services configured through settings aren't flagged as "missing".
    const configStoreHints: Record<string, string> = {
      github: "GITHUB_TOKEN",
    };

    const resolved: Record<string, string> = { ...preResolvedCredentials };
    const missing: string[] = [];

    for (const hint of expandedHints) {
      if (resolved[hint]) continue;
      const found = await this.findCredentialInMemory(userId!, hint);
      if (found) {
        resolved[hint] = found;
        logger.info({ hint, found: found.substring(0, 20) + "..." }, "Credential found in memory");
      } else {
        // Check config store env vars (e.g. GitHub token from Web UI settings)
        const envKey = configStoreHints[hint.toLowerCase()];
        if (envKey && process.env[envKey]) {
          resolved[hint] = `[configurado via settings]`;
          logger.info({ hint, envKey }, "Credential found in config store");
        } else {
          missing.push(hint);
        }
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
      // NOTE: user message already saved and notified by handleMessageInternal — no duplicate save here
      return `Vou precisar de credenciais para ${missingList} pra fazer isso.\n\nMe manda as credenciais de *${missing[0]}* (usuario, senha, token, o que for necessario).`;
    }

    if (missing.length > 0) {
      logger.info({ missing, resolved: Object.keys(resolved) }, "Proceeding with partial credentials");
    }

    // NOTE: user message already saved and notified by handleMessageInternal — no duplicate save here

    // Start the sub-agent container
    let session;
    try {
      session = await this.sessionManager.createSession(
        userMessage, connectorName, userPhone, resolved, env, imageMedias, userId
      );
    } catch (err) {
      logger.error({ err }, "Sub-agent session failed");
      return `Erro ao executar sub-agente: ${(err as Error).message}`;
    }

    // Build ack with variant name + public session link (if webBaseUrl configured)
    const variantName = await getSessionVariantName(session.id, userId);
    const baseUrl = config.webBaseUrl;
    let ack: string;
    if (baseUrl && userId) {
      const userToken = getUserSessionsToken(userId);
      const sessionUrl = `${baseUrl}/u/${userToken}#${session.id}`;
      ack = `O *${variantName}* vai cuidar disso pra voce, pode acompanhar aqui:\n${sessionUrl}`;
    } else {
      ack = `O *${variantName}* vai cuidar disso pra voce. Aguarde o resultado.`;
    }

    await this.memory.saveMessageByUserId(userId!, "assistant", ack, undefined, undefined, undefined, undefined, undefined, undefined, connectorName);
    this.notifyMainViewers(userId!, "agent", ack, "text", connectorName);

    return ack;
  }

  /**
   * Search user's memories for credentials matching a service name.
   * Looks in categories: senhas, credenciais, tokens, contatos, general.
   */
  private async findCredentialInMemory(userId: number, service: string): Promise<string | null> {
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
    userId: number,
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
    await this.memory.rememberV2(currentMissing, text.trim(), "credenciais", userId, userRole);
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
      userId
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
    userId?: number,
    signal?: AbortSignal
  ): Promise<string | null> {
    const doneSessions = this.sessionManager.getDoneSessionsForUser(userPhone);
    if (doneSessions.length === 0) return "Nenhuma sessao pendente.";

    const lower = text.trim().toLowerCase();
    const mostRecent = this.sessionManager.getMostRecentDoneSessionForUser(userPhone)!;

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
      const remaining = this.sessionManager.getDoneSessionsForUser(userPhone);
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
      const classification = await classifyTask(text, signal);
      if (classification) {
        // CASE 3: New DELEGATE task — nag to close pending sessions first
        const sessionList = doneSessions
          .map((s) => `- "${s.taskDescription.substring(0, 60)}..."`)
          .join("\n");
        return `Antes de abrir outra sessao, preciso que voce resolva as pendentes:\n\n${sessionList}\n\nMarca *Sim* na enquete pra encerrar, ou me pede um ajuste nessa mesma sessao.`;
      }
      // CASE 4: SELF task that doesn't share topic — NOT a continuation.
      // Return null to signal the caller should handle this as normal chat.
      logger.info({ text: text.substring(0, 60), userPhone }, "SELF task while done sessions exist — passing to normal chat");
      return null;
    } else {
      logger.info({ text: text.substring(0, 60), sessionId: mostRecent.id }, "Treating as session continuation (topic match)");
    }

    // CASE 2: Continuation — relay to the most recent done session
    // NOTE: user message already saved and notified by handleMessageInternal — no duplicate save here

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
   * Pre-warm OAuth tokens so they're fresh in the DB for sub-agents.
   * The main session itself only uses Gemini — these tokens are consumed by
   * sub-agents via the /api/agent/llm-token endpoint.
   */
  private async ensureOAuthTokens(userId: number): Promise<void> {
    // Claude (with admin fallback) — just validate/refresh, don't set on LLM service
    try {
      await this.resolveClaudeToken(userId);
    } catch (err) {
      logger.warn({ err }, "Failed to pre-warm Claude OAuth token");
    }

    // OpenAI (with admin fallback) — just validate/refresh, don't set on LLM service
    try {
      await this.resolveOpenAIToken(userId);
    } catch (err) {
      logger.warn({ err }, "Failed to pre-warm OpenAI OAuth token");
    }
  }

  /**
   * Build a dynamic section listing configured integrations.
   * Tells the LLM what external services are available WITHOUT revealing secrets.
   */
  private buildIntegrationsSection(): string {
    const integrations: string[] = [];
    if (process.env.GITHUB_TOKEN) integrations.push("GitHub (token configurado — push/pull de repositorios)");
    if (process.env.DATABASE_URL) integrations.push("PostgreSQL (banco de dados externo)");
    if (process.env.PGVECTOR_URL) integrations.push("PGVector (memoria semantica)");

    if (integrations.length === 0) return "";

    let section = "\nINTEGRACOES CONFIGURADAS:\n";
    for (const i of integrations) {
      section += `- ${i}\n`;
    }
    section += "Voce pode confirmar que essas integracoes estao disponiveis, mas NUNCA revele tokens ou credenciais.\n\n";
    return section;
  }

  private buildSystemPrompt(
    userName: string | null,
    memoryContext: string,
    semanticContext: string,
    userRole: UserRole = "admin",
    isDirectChat: boolean = false
  ): string {
    const name = config.agentName;
    const userRef = userName ? userName : "o usuario";

    const hasSemanticMemory = !!this.vectorMemory;
    const userCanDelegate = canInvokeSubAgent(userRole);

    let prompt = `Voce e ${name}, um assistente de IA com memoria persistente. Estou a disposicao para ajudar com o que for necessario.

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
- Voce pode listar, buscar, ou apagar memorias${userCanDelegate ? `
- Existe um sub-agente autonomo que pode ser acionado para tarefas complexas (programar, pesquisar na web, acessar contas via browser). O roteamento e automatico e acontece ANTES desta conversa.
- Credenciais do sub-agente ficam na categoria "credenciais" ou "senhas" da sua memoria
- Conexoes OAuth (Claude, GPT) sao gerenciadas pelo painel de configuracoes na interface web` : ""}

${this.buildIntegrationsSection()}
REGRA ANTI-ALUCINACAO (CRITICA — NUNCA viole):
- NUNCA invente informacoes que voce nao tem. Se nao sabe, diga que nao sabe.
- NUNCA finja ter executado acoes que nao executou.
- NUNCA fabrique dados ficticios (emails, notificacoes, mensagens, etc).
- Se voce nao tem certeza se pode fazer algo, diga honestamente e sugira alternativas.
- VOCE NAO TEM ACESSO A NENHUM SERVICO EXTERNO (email, sites, contas).${isDirectChat && userCanDelegate ? `

IMPORTANTE SOBRE SUB-AGENTE:
- Esta mensagem esta sendo tratada por voce diretamente (chat simples). O sistema de roteamento automatico JA decidiu que esta mensagem NAO precisa de sub-agente.
- NUNCA diga "vou delegar ao sub-agente" ou "vou acionar o sub-agente" nesta resposta — isso NAO vai acontecer.
- Se o usuario pedir algo que voce nao pode fazer diretamente (acessar email, programar, pesquisar na web), diga honestamente: "Isso seria uma tarefa pro sub-agente. Tenta me pedir de forma mais direta, por exemplo: 'Cria um app React' ou 'Checa meus emails'."
- NUNCA finja que fez algo que so o sub-agente poderia fazer. NUNCA diga "Pronto, apaguei" ou "Feito, enviei".` : isDirectChat && !userCanDelegate ? `
- NUNCA mencione sub-agentes. Este usuario nao tem acesso a essa funcionalidade.
- NUNCA diga "vou delegar" ou "vou acionar o sub-agente". Responda diretamente com o que voce sabe.` : `
- Quando o usuario pedir algo que requer o sub-agente (codigo, pesquisa, acessar emails), o roteamento e automatico.
- Se o sub-agente nao retornou resultado, NAO invente um resultado.
- Se o usuario pedir para APAGAR, ENVIAR, MODIFICAR, ou REALIZAR qualquer acao em uma conta ou servico externo, diga: "Preciso acionar o sub-agente pra isso. Vou delegar a tarefa." NAO diga que fez a acao voce mesmo. NUNCA diga "Pronto, apaguei" ou "Feito, enviei" — isso e MENTIRA se voce nao delegou ao sub-agente.`}`;

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

  /**
   * Detect implicit OAuth code pasting (not slash commands — automatic pattern matching).
   * Returns a response string if an OAuth code was detected, null otherwise.
   */
  private async handleImplicitOAuth(text: string, userId: number): Promise<string | null> {
    // Check if user is pasting a Claude OAuth code (contains # separator)
    if (this.claudeOAuth.hasPendingAuth() && text.includes("#") && !text.startsWith("/")) {
      const exchangeResult = await this.cmdExchangeClaudeCode(userId, text);
      if (exchangeResult) return exchangeResult;
    }

    // Check if user is pasting an OpenAI OAuth callback URL
    if (this.openaiOAuth.hasPendingAuth() && text.includes("localhost") && text.includes("code=")) {
      return this.cmdExchangeGPTCallback(userId, text);
    }

    return null;
  }

  // ==================== OAUTH CODE EXCHANGE ====================

  private async cmdExchangeClaudeCode(
    userId: number,
    rawCode: string
  ): Promise<string | null> {
    const result = await this.claudeOAuth.exchangeCode(userId, rawCode);

    if (!result.success) {
      return result.error || "Erro ao conectar. Tente novamente pelas configuracoes.";
    }

    return `*Claude conectado com sucesso!*

Conta: ${result.email || "conectada"}

O sub-agente agora pode usar o Claude Opus. O token e renovado automaticamente.`;
  }

  private async cmdExchangeGPTCallback(
    userId: number,
    rawUrl: string
  ): Promise<string> {
    const result = await this.openaiOAuth.exchangeCallback(userId, rawUrl);

    if (!result.success) {
      return result.error || "Erro ao conectar. Tente novamente pelas configuracoes.";
    }

    return `*GPT conectado com sucesso!*

Conta: ${result.email || "conectada"}

O sub-agente agora pode usar o GPT Codex como fallback. O token e renovado automaticamente.`;
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

  // ==================== AUTO-EXTRACTION ====================

  private async buildSemanticContext(userId: number, queryText: string, userRole: UserRole = "admin"): Promise<string> {
    if (!this.vectorMemory) return "";

    try {
      // RBAC: Use global search (no user filter) with creator info
      const results = await this.vectorMemory.searchGlobal(queryText, 5, 0.35);
      if (results.length === 0) {
        // Fallback to legacy per-user search if no global results
        const legacyResults = await this.vectorMemory.searchGlobal(queryText, 5, 0.35);
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
    userId: number,
    userMessage: string,
    assistantResponse: string
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
      }, userId);
    } catch (err) {
      logger.warn({ err }, "Failed to embed conversation");
    }
  }

  private async extractAndSaveMemories(
    userId: number,
    userMessage: string,
    assistantResponse: string,
    userRole: UserRole = "admin"
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
            await this.memory.rememberV2(match[1].trim(), match[2].trim(), "senhas", userId, userRole);
          }
        } catch (err) {
          logger.warn({ err, pattern: pattern.regex.source }, "Failed to auto-save memory");
        }
      }
    }

    // NOTE: Auto-forget via regex was removed (was too greedy — matched casual
    // messages like "remove esse erro" and deleted memories). Memory deletion
    // now requires explicit user confirmation or Web UI management.

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
      this.llmExtractMemories(userId, userMessage, assistantResponse, userRole).catch((err) => {
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
    userId: number,
    userMessage: string,
    assistantResponse: string,
    userRole: UserRole = "admin"
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
      logger.info({ userId, msgSnippet: userMessage.substring(0, 80) }, "llmExtractMemories: calling Gemini for extraction");
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
                { userId, key: normalizedKey },
                "Preserved richer existing credential value"
              );
            }
          }
        }

        // RBAC: Use rememberV2 with hierarchy enforcement
        const memResult = await this.memory.rememberV2(normalizedKey, finalValue, normalizedCategory, userId, userRole);
        if (memResult.blocked) {
          logger.info(
            { userId, category: normalizedCategory, key: normalizedKey, existingValue: memResult.existingValue?.substring(0, 50) },
            "LLM extraction blocked by hierarchy"
          );
          continue;
        }
        logger.info(
          { userId, category: normalizedCategory, key: normalizedKey, valueLen: finalValue.length },
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
   * sessions and other agent internals.
   */
  createWebBridge(webConnector: WebConnector): WebAgentBridge {
    // Wire session message callback so sub-agent messages go to public session pages
    this.sessionManager.setSessionMessageCallback((sessionId, role, text, messageType, mediaInfo) => {
      webConnector.broadcastToSessionSubscribers(sessionId, role, text, messageType, mediaInfo);
    });

    const bridge: WebAgentBridge = {
      getSessionsForUI: () => {
        const sessions = this.sessionManager.getLiveSessions();
        return sessions
          .map((s) => ({
            id: s.id,
            state: s.state,
            taskDescription: s.taskDescription,
            variantName: s.variantName,
            createdAt: s.createdAt,
            updatedAt: s.updatedAt,
          }))
          .sort((a, b) => b.updatedAt - a.updatedAt);
      },

      killSession: async (sessionId: string) => {
        await this.sessionManager.killSession(sessionId);
      },

      sendToSession: async (
        sessionId: string,
        message: string,
        images?: import("./llm/types.js").MediaAttachment[],
        audioUrl?: string,
        imageUrls?: string[],
        fileInfos?: Array<{ url: string; name: string; mimeType: string }>
      ) => {
        await this.sessionManager.sendToSession(sessionId, message, images, audioUrl, imageUrls, fileInfos);
      },

      getConversationHistory: async (userPhone: string, limit?: number, numericUserId?: number) => {
        // Always use user_id-based history
        return this.memory.getConversationHistoryByUserId(numericUserId!, limit);
      },

      getSessionHistory: async (sessionId: string) => {
        return this.sessionManager.getSessionHistory(sessionId);
      },

      getSessionInfoFromDB: async (sessionId: string) => {
        return this.sessionManager.getSessionInfoFromDB(sessionId);
      },

      sendTranscription: (audioUrl: string, transcription: string) => {
        webConnector.sendTranscription(audioUrl, transcription);
      },

      clearConversation: async (userPhone: string, numericUserId?: number) => {
        // Always use user_id-based clear
        await this.memory.clearConversationByUserId(numericUserId!);
      },

      createBlankSubAgentSession: async (connectorName: string, userId: string): Promise<string> => {
        const numUserId = Number(userId);
        const env = await this.buildSubAgentEnv(numUserId);

        let session;
        try {
          // Empty taskDescription → session starts in "waiting_user" state
          // numUserId passado para garantir audit trail no DB (persistSessionToDB exige numericUserId)
          session = await this.sessionManager.createSession("", connectorName, userId, {}, env, undefined, numUserId || undefined);
        } catch (err) {
          logger.error({ err }, "Failed to create blank sub-agent session");
          throw err;
        }

        const variantName = await getSessionVariantName(session.id, numUserId || undefined);
        const baseUrl = config.webBaseUrl;
        let ack: string;
        if (baseUrl && numUserId) {
          const userToken = getUserSessionsToken(numUserId);
          const sessionUrl = `${baseUrl}/u/${userToken}#${session.id}`;
          ack = `Sessao *${variantName}* aberta e aguardando sua primeira tarefa:\n${sessionUrl}`;
        } else {
          ack = `Sessao *${variantName}* aberta e aguardando sua primeira tarefa.`;
        }
        await this.memory.saveMessageByUserId(numUserId, "assistant", ack, undefined, undefined, undefined, undefined, undefined, undefined, "web");
        return ack;
      },

      getConversationHistoryByUserId: async (userId: number, limit?: number) => {
        return this.memory.getConversationHistoryByUserId(userId, limit);
      },

      handleMainViewerMessage: async (numericUserId: number, userExternalId: string, text: string, userName?: string, userRole?: string, media?: import("./llm/types.js").MediaAttachment, imageMedias?: import("./llm/types.js").MediaAttachment[], audioUrl?: string, imageUrls?: string[], fileInfos?: Array<{ url: string; name: string; mimeType: string }>) => {
        const validRoles = ["admin", "dev", "business"];
        const resolvedRole = userRole && validRoles.includes(userRole) ? userRole as "admin" | "dev" | "business" : "admin";
        const incoming: IncomingMessage = {
          connectorName: "main-viewer",
          userId: userExternalId,
          userName: userName || undefined,
          numericUserId,
          text,
          media,
          imageMedias: imageMedias && imageMedias.length > 0 ? imageMedias : undefined,
          audioUrl,
          imageUrls: imageUrls && imageUrls.length > 0 ? imageUrls : undefined,
          fileInfos: fileInfos && fileInfos.length > 0 ? fileInfos : undefined,
          userRole: resolvedRole,
          userStatus: "active",
          skipSubAgentRelay: true,
        };
        return this.handleMessage(incoming);
      },

      setMainSessionCallback: (cb: (userId: number, role: string, text: string, messageType?: string, connectorName?: string, mediaInfo?: { audioUrl?: string; imageUrls?: string[]; fileInfos?: Array<{ url: string; name: string; mimeType: string }> }) => void) => {
        this.mainSessionCallback = cb;
      },

      setMainTypingCallback: (cb: (userId: number, composing: boolean) => void) => {
        this.mainTypingCallback = cb;
      },

      interruptUser: (userId: string): boolean => {
        return this.interruptUser(userId);
      },

      isUserProcessing: (userId: string): boolean => {
        return this.isUserProcessing(userId);
      },

      interruptSession: (sessionId: string): boolean => {
        return this.sessionManager.interruptSession(sessionId);
      },

      isSessionProcessing: (sessionId: string): boolean => {
        return this.sessionManager.isSessionProcessing(sessionId);
      },
    };

    this.webBridge = bridge;
    return bridge;
  }
}
