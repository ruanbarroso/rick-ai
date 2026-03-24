import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  WASocket,
  WAMessage,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  getContentType,
  proto,
  jidNormalizedUser,
  decryptPollVote,
  getAggregateVotesInPollMessage,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import pino from "pino";
import path from "path";
import { promises as fs } from "node:fs";
import type { Connector, ConnectorCapabilities, IncomingMessage, SendMessageOptions } from "./types.js";
import type { ConnectorManager } from "./connector-manager.js";
import { MemoryService } from "../memory/memory-service.js";
import { UserService } from "../auth/user-service.js";
import { canChat } from "../auth/permissions.js";
import { MediaAttachment } from "../llm/types.js";
import { logger } from "../config/logger.js";
import { config } from "../config/env.js";

const AUTH_DIR = path.join(process.cwd(), "auth_info");

/**
 * Build the correct JID for an external_id stored in connector_identities.
 *
 * Modern WhatsApp (Baileys v7) may identify users by either:
 *  - Phone number (e.g. "5534XXXXXXXX") → "5534XXXXXXXX@s.whatsapp.net"
 *  - LID (Linked ID, e.g. "139496712581324") → "139496712581324@lid"
 *
 * We store the bare identifier in the DB.  At send-time we need to
 * reconstruct the full JID.  The heuristic: Brazilian phone numbers
 * are 12-13 digits (55 + 2-digit area + 8-9-digit number) while LIDs
 * are 15+ digit opaque identifiers that don't start with a country code.
 *
 * NOTE: This also works with a stored LID-to-JID map if we build one later.
 */
function toJid(externalId: string): string {
  // LIDs are 15 digits; phone numbers (with country code) are ≤ 13
  if (externalId.length >= 15) {
    return `${externalId}@lid`;
  }
  return `${externalId}@s.whatsapp.net`;
}

/**
 * WhatsApp connector using Baileys v7.
 *
 * Implements the Connector interface so the Agent can communicate
 * through WhatsApp without knowing anything about Baileys internals.
 *
 * RBAC: processes messages from any 1:1 chat (not just self-chat).
 * Users are resolved via connector_identities and filtered by role/status.
 */
export class WhatsAppConnector implements Connector {
  readonly name = "whatsapp";
  readonly capabilities: ConnectorCapabilities = {
    polls: true,
    typing: true,
    media: true,
    richText: true, // WhatsApp supports *bold*, _italic_, ~strikethrough~, ```code```
  };

  private sock: WASocket | null = null;
  private manager: ConnectorManager;
  private memory: MemoryService;
  private userService: UserService;
  private myJid: string | null = null;
  private myLid: string | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private manualDisconnectInProgress = false;
  private processing = new Set<string>();

  /** Interval that refreshes "composing" presence every 10s (WhatsApp auto-expires after ~25s). */
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

  /**
   * Store poll creation messages so we can decrypt votes later.
   * Capped at MAX_POLL_MESSAGES to prevent unbounded memory growth.
   */
  private pollMessages = new Map<string, WAMessage>();
  private static readonly MAX_POLL_MESSAGES = 100;

  /**
   * Cache da versão do WhatsApp Web para evitar fetch de rede a cada reconexão.
   * Preenchido na primeira chamada de start().
   */
  private static versionCache: [number, number, number] | null = null;

  /**
   * Debounce buffer for rapid text-only messages from the same user.
   * When a user sends multiple texts in quick succession (e.g. "Acessa nosso GitHub"
   * followed by "Vê os bugs que temos" 5 seconds later), we combine them into a
   * single message so only one sub-agent is created.
   * Messages with media (audio/image/document) flush the buffer immediately.
   */
  private static readonly TEXT_DEBOUNCE_MS = 3000;
  private pendingTexts = new Map<string, {
    texts: string[];
    timer: ReturnType<typeof setTimeout>;
    chatJid: string;
    senderId: string;
    user: { id: number; phone: string; displayName: string | null; role: string | null; status: string };
    quotedText?: string;
  }>();

  /**
   * Callback for QR code events — allows the web connector or other
   * consumers to receive QR codes for display.
   */
  private qrListeners: Array<(qr: string) => void> = [];
  private statusListeners: Array<(connected: boolean) => void> = [];

  /**
   * Callback notified when a new pending user is created.
   * Used to push badge updates to the Web UI.
   */
  private pendingUserListeners: Array<() => void> = [];

  constructor(manager: ConnectorManager, memory: MemoryService, userService: UserService) {
    this.manager = manager;
    this.memory = memory;
    this.userService = userService;
  }

  // ==================== Connector interface ====================

  async start(): Promise<void> {
    if (this.sock !== null) {
      logger.warn("WhatsApp connector já está iniciando ou conectado, ignorando start() duplicado.");
      return;
    }

    // If creds exist but were from a revoked session (me set + registered false),
    // clear them so Baileys generates a fresh QR instead of looping 401s.
    try {
      const credsPath = path.join(AUTH_DIR, "creds.json");
      const raw = await fs.readFile(credsPath, "utf-8").catch(() => "");
      if (raw) {
        const creds = JSON.parse(raw);
        if (creds.me && creds.registered === false) {
          logger.warn("Stale creds detected (me set but not registered) — clearing auth_info for fresh QR.");
          await fs.rm(AUTH_DIR, { recursive: true, force: true });
        }
      }
    } catch {}

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    // Busca a versão do WA Web apenas uma vez — reutiliza o cache nas reconexões
    if (!WhatsAppConnector.versionCache) {
      const { version: v } = await fetchLatestBaileysVersion();
      WhatsAppConnector.versionCache = v;
    }
    const version = WhatsAppConnector.versionCache;

    const pinoLogger = pino({ level: "silent" });

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pinoLogger as any),
      },
      printQRInTerminal: false,
      logger: pinoLogger as any,
      generateHighQualityLinkPreview: true,
    });

    this.sock = sock;

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log("\n========================================");
        console.log("  Escaneie o QR code abaixo no WhatsApp");
        console.log("========================================\n");
        qrcode.generate(qr, { small: true });
        console.log("\nWhatsApp > Dispositivos conectados > Conectar dispositivo\n");

        // Notify QR listeners (e.g., web connector)
        for (const listener of this.qrListeners) {
          try { listener(qr); } catch {}
        }
      }

      if (connection === "close") {
        const reason = (lastDisconnect?.error as any)?.output?.statusCode;
        const shouldReconnect = reason !== DisconnectReason.loggedOut;

        logger.warn({ reason, shouldReconnect }, "WhatsApp connection closed");

        this.sock = null;
        this.myJid = null;
        this.myLid = null;
        import("../health.js").then(({ setHealthy }) => setHealthy("whatsappConnected", false)).catch(() => {});
        for (const listener of this.statusListeners) {
          try { listener(false); } catch {}
        }

        if (this.manualDisconnectInProgress) {
          this.manualDisconnectInProgress = false;
          return;
        }

        if (shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 60000);
          logger.info({ attempt: this.reconnectAttempts, delay }, "Reconnecting...");
          setTimeout(() => this.start(), delay);
        } else if (!shouldReconnect) {
          // Ensure the socket is fully dead before clearing auth — otherwise
          // a pending saveCreds callback can re-write creds.json after rm.
          try { sock.ev.removeAllListeners("creds.update"); } catch {}
          try { sock.end(undefined); } catch {}
          logger.warn("Logged out — clearing stale auth_info so next connect generates a fresh QR.");
          await fs.rm(AUTH_DIR, { recursive: true, force: true }).catch(() => {});
        }
      }

      if (connection === "open") {
        this.reconnectAttempts = 0;
        this.myJid = sock.user?.id || null;
        this.myLid = (sock.user as any)?.lid || null;
        logger.info({ myJid: this.myJid, myLid: this.myLid }, "WhatsApp connected!");
        console.log("\n✓ Conectado ao WhatsApp com sucesso!\n");

        // Signal health check
        import("../health.js").then(({ setHealthy }) => setHealthy("whatsappConnected", true)).catch(() => {});
        for (const listener of this.statusListeners) {
          try { listener(true); } catch {}
        }
      }
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("messages.upsert", async ({ messages, type }: any) => {
      if (type !== "notify") return;

      for (const msg of messages) {
        await this.handleIncomingMessage(msg);
      }
    });
  }

  async stop(): Promise<void> {
    // Clear all typing refresh intervals
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();

    // Clear all pending debounce timers (don't flush — we're shutting down)
    for (const entry of this.pendingTexts.values()) {
      clearTimeout(entry.timer);
    }
    this.pendingTexts.clear();

    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
      this.myJid = null;
      this.myLid = null;
      import("../health.js").then(({ setHealthy }) => setHealthy("whatsappConnected", false)).catch(() => {});
    }
  }

  async disconnectForRelogin(): Promise<void> {
    this.manualDisconnectInProgress = true;

    // Remove creds listener first to prevent re-writes during cleanup
    try { this.sock?.ev.removeAllListeners("creds.update"); } catch {}

    try {
      if (this.sock) {
        await this.sock.logout();
      }
    } catch (err) {
      logger.warn({ err }, "WhatsApp logout failed, forcing disconnect");
    }

    await this.stop();

    // Retry rm up to 3 times — EBUSY can happen if file handles linger
    for (let i = 0; i < 3; i++) {
      try {
        await fs.rm(AUTH_DIR, { recursive: true, force: true });
        break;
      } catch (err) {
        if (i < 2) await new Promise(r => setTimeout(r, 500));
        else logger.warn({ err }, "Could not fully remove auth_info — will be cleaned on next start");
      }
    }

    this.reconnectAttempts = 0;
    await this.start();
  }

  async sendMessage(userId: string, text: string, options?: SendMessageOptions): Promise<void> {
    // Mensagens de tool execution (tipo 3) não devem ser enviadas ao WhatsApp
    if (options?.messageType === "tool_use") {
      logger.debug({ userId }, "WhatsApp: skipping tool_use message");
      return;
    }
    if (!this.sock) {
      logger.warn({ userId }, "WhatsApp: cannot send message — not connected");
      return;
    }
    // userId here is the external_id from connector_identities (phone or LID)
    const jid = toJid(userId);
    await this.sendTextMessage(jid, text);
  }

  async sendPoll(userId: string, question: string, options: string[]): Promise<void> {
    if (!this.sock) return;
    const jid = toJid(userId);
    await this.sendPollMessage(jid, question, options);
  }

  async setTyping(userId: string, composing: boolean): Promise<void> {
    if (!this.sock) return;
    const jid = toJid(userId);

    // Clear any existing refresh interval for this user
    const existing = this.typingIntervals.get(userId);
    if (existing) {
      clearInterval(existing);
      this.typingIntervals.delete(userId);
    }

    try {
      await this.sock.presenceSubscribe(jid);
      await this.sock.sendPresenceUpdate(composing ? "composing" : "paused", jid);
    } catch (err) {
      logger.warn({ err }, "Failed to update WhatsApp presence");
    }

    // WhatsApp auto-expires "composing" after ~25s. Refresh every 10s while active.
    if (composing) {
      const interval = setInterval(async () => {
        try {
          if (this.sock) {
            await this.sock.sendPresenceUpdate("composing", jid);
          } else {
            clearInterval(interval);
            this.typingIntervals.delete(userId);
          }
        } catch {
          // Ignore — best effort
        }
      }, 10_000);
      this.typingIntervals.set(userId, interval);
    }
  }

  // ==================== QR Code API ====================

  /**
   * Returns true if the socket was created but the connection is not yet
   * authenticated (i.e. waiting for QR code scan).
   */
  isStarting(): boolean {
    return this.sock !== null && this.myJid === null;
  }

  /**
   * Register a listener for QR code events.
   * Called by the web connector to forward QR codes to the browser.
   */
  onQrCode(listener: (qr: string) => void): void {
    this.qrListeners.push(listener);
  }

  onConnectionChange(listener: (connected: boolean) => void): void {
    this.statusListeners.push(listener);
  }

  /**
   * Register a listener notified when a new pending user is created.
   */
  onPendingUser(listener: () => void): void {
    this.pendingUserListeners.push(listener);
  }

  /**
   * Check if WhatsApp is currently connected.
   */
  isConnected(): boolean {
    return this.sock !== null && this.myJid !== null;
  }

  // ==================== Internal message handling ====================

  private async handleIncomingMessage(msg: any): Promise<void> {
    try {
      const chatJid = msg.key.remoteJid || "";
      const msgId = msg.key.id || "";
      const fromMe = msg.key.fromMe;

      if (chatJid === "status@broadcast") return;
      if (!msg.message) return;
      if (msg.message.protocolMessage) return;

      // Skip group messages — only process 1:1 chats
      if (chatJid.endsWith("@g.us")) return;

      // Check for poll update (vote) messages
      const inner = msg.message.ephemeralMessage?.message || msg.message;
      if (inner.pollUpdateMessage) {
        await this.handlePollUpdate(msg);
        return;
      }

      // Extract text, detect audio, image, and document
      const text = this.extractText(msg);
      const audioInfo = this.extractAudioInfo(msg);
      const imageInfo = this.extractImageInfo(msg);
      const docInfo = this.extractDocumentInfo(msg);

      // Skip if no text, audio, image, or document
      if (!text && !audioInfo && !imageInfo && !docInfo) return;

      // Dedup: skip if already being processed
      if (this.processing.has(msgId)) return;
      this.processing.add(msgId);
      setTimeout(() => this.processing.delete(msgId), 60000);

      // Check if this message was sent by the AGENT (already in DB)
      const isFromAgent = await this.memory.isAgentMessage(msgId);
      if (isFromAgent) return;

      // Skip messages from self (fromMe) — admin uses Web UI only
      if (fromMe) return;

      // Resolve the best identifier for this user.
      // Baileys v7 may use LID-based JIDs (@lid) instead of phone-based ones.
      // We always prefer the phone number because LIDs are opaque and create
      // duplicate users when the same person sends from both JID types.
      //
      // Priority:
      // 1. remoteJidAlt (Baileys v7 field — phone JID when primary is LID)
      // 2. signalRepository.lidMapping.getPNForLID() (internal Baileys mapping)
      // 3. remoteJid itself (fallback)
      const senderId = this.resolvePhoneNumber(chatJid, msg.key.remoteJidAlt);
      const pushName = msg.pushName || undefined;

      // Track message in message_log for dedup
      const trackText = text || (audioInfo ? "[audio]" : docInfo ? `[arquivo: ${docInfo.fileName}]` : "[imagem]");
      await this.memory.trackMessage(msgId, "USER", trackText);

      // ==================== RBAC: Resolve user ====================
      const user = await this.userService.resolveUser("whatsapp", senderId, pushName);
      const isNewPending = user.status === "pending" && user.role === null;

      // Update activity timestamp
      await this.userService.updateLastActivity(user.id);

      // Download audio early (before the admin-visibility save) so the blob URL
      // is available for playback in the main-session viewer.
      let earlyAudioUrl: string | undefined;
      let earlyAudioBuffer: Buffer | undefined;
      let earlyImageUrl: string | undefined;
      let earlyFileInfo: { url: string; name: string; mimeType: string } | undefined;
      if (audioInfo) {
        try {
          earlyAudioBuffer = await downloadMediaMessage(msg, "buffer", {}) as Buffer;
          try {
            const { query: dbQuery } = await import("../memory/db.js");
            const id = Array.from({ length: 8 }, () =>
              Math.floor(Math.random() * 256).toString(16).padStart(2, "0")
            ).join("");
            await dbQuery(
              `INSERT INTO audio_blobs (id, data, mime_type) VALUES ($1, $2, $3)`,
              [id, earlyAudioBuffer, audioInfo.mimeType]
            );
            earlyAudioUrl = `/audio/${id}`;
          } catch (blobErr) {
            logger.warn({ err: blobErr }, "Failed to save WhatsApp audio blob");
          }
        } catch (err) {
          logger.error({ err }, "Failed to download audio (early)");
          // Don't block the save — just won't have playback
        }
      }

      // Save message to conversation history regardless of status (for admin visibility)
      const messageText = text || (audioInfo ? "[audio]" : docInfo ? `[arquivo: ${docInfo.fileName}]` : "[imagem]");
      const earlyImageUrls = earlyImageUrl ? [earlyImageUrl] : undefined;
      const earlyFileInfos = earlyFileInfo ? [earlyFileInfo] : undefined;
      await this.memory.saveMessageByUserId(user.id, "user", messageText, undefined, undefined, earlyAudioUrl, earlyImageUrls, undefined, earlyFileInfos, "whatsapp");

      // Notify pending user listeners (for badge updates)
      if (isNewPending) {
        for (const listener of this.pendingUserListeners) {
          try { listener(); } catch {}
        }
      }

      // If user is blocked or pending, don't process further (no LLM, no response)
      if (user.status === "blocked") {
        logger.debug({ userId: user.id, senderId }, "Blocked user message saved, no response");
        return;
      }
      if (user.status === "pending" || !user.role || !canChat(user.role)) {
        logger.debug({ userId: user.id, senderId }, "Pending user message saved, no response");
        return;
      }

      // ==================== Process message for active users ====================

      // Extract quoted message text (if user replied to a message)
      const quotedText = this.extractQuotedText(msg);

      // Download media if present (audio, image, or document/file)
      let media: MediaAttachment | undefined;
      const audioUrl = earlyAudioUrl; // set earlier for admin-visibility save
      if (audioInfo) {
        if (earlyAudioBuffer) {
          media = { data: earlyAudioBuffer, mimeType: audioInfo.mimeType };
        } else {
          // Early download failed — retry
          try {
            const buffer = await downloadMediaMessage(msg, "buffer", {}) as Buffer;
            media = { data: buffer, mimeType: audioInfo.mimeType };
          } catch (err) {
            logger.error({ err }, "Failed to download audio");
            await this.sendTextMessage(chatJid, "Nao consegui baixar o audio. Tenta enviar de novo?");
            return;
          }
        }
        logger.info(
          { from: senderId, type: "audio", seconds: audioInfo.seconds, ptt: audioInfo.ptt, audioUrl },
          "Audio message received"
        );
      } else if (imageInfo) {
        try {
          const buffer = await downloadMediaMessage(msg, "buffer", {});
          media = {
            data: buffer as Buffer,
            mimeType: imageInfo.mimeType,
          };
          // Save image blob for viewer display (same pattern as audio blobs)
          try {
            const { query: dbQuery } = await import("../memory/db.js");
            const id = Array.from({ length: 8 }, () =>
              Math.floor(Math.random() * 256).toString(16).padStart(2, "0")
            ).join("");
            await dbQuery(
              `INSERT INTO audio_blobs (id, data, mime_type) VALUES ($1, $2, $3)`,
              [id, buffer, imageInfo.mimeType]
            );
            earlyImageUrl = `/img/${id}`;
          } catch (blobErr) {
            logger.warn({ err: blobErr }, "Failed to save WhatsApp image blob");
          }
          logger.info(
            { from: senderId, type: "image", mimeType: imageInfo.mimeType, hasCaption: !!text, imageUrl: earlyImageUrl },
            "Image message received"
          );
        } catch (err) {
          logger.error({ err }, "Failed to download image");
          await this.sendTextMessage(chatJid, "Nao consegui baixar a imagem. Tenta enviar de novo?");
          return;
        }
      } else if (docInfo) {
        try {
          const buffer = await downloadMediaMessage(msg, "buffer", {});
          media = {
            data: buffer as Buffer,
            mimeType: docInfo.mimeType,
            fileName: docInfo.fileName,
          };
          // Save document blob for viewer display
          try {
            const { query: dbQuery } = await import("../memory/db.js");
            const id = Array.from({ length: 8 }, () =>
              Math.floor(Math.random() * 256).toString(16).padStart(2, "0")
            ).join("");
            await dbQuery(
              `INSERT INTO audio_blobs (id, data, mime_type) VALUES ($1, $2, $3)`,
              [id, buffer, docInfo.mimeType]
            );
            earlyFileInfo = { url: `/file/${id}`, name: docInfo.fileName, mimeType: docInfo.mimeType };
          } catch (blobErr) {
            logger.warn({ err: blobErr }, "Failed to save WhatsApp document blob");
          }
          logger.info(
            { from: senderId, type: "document", mimeType: docInfo.mimeType, fileName: docInfo.fileName, hasCaption: !!text },
            "Document message received"
          );
        } catch (err) {
          logger.error({ err }, "Failed to download document");
          await this.sendTextMessage(chatJid, "Nao consegui baixar o arquivo. Tenta enviar de novo?");
          return;
        }
      } else {
        logger.info(
          {
            from: senderId,
            text: (text || "").substring(0, 100),
            ...(quotedText ? { quotedText: quotedText.substring(0, 80) } : {}),
          },
          "Message received"
        );
      }

      // Build the text prompt
      let promptText: string;
      if (media && audioInfo) {
        promptText = text || "O usuario enviou um audio. Ouça, entenda e responda naturalmente.";
      } else if (media && imageInfo) {
        promptText = text || "O usuario enviou uma imagem. Analise a imagem e descreva o que voce ve.";
      } else if (media && docInfo) {
        const fname = docInfo.fileName;
        const docMime = docInfo.mimeType || "";
        const isTextMime = docMime.startsWith("text/") || docMime === "application/json" || docMime === "application/xml" || docMime === "application/javascript";
        const isLikelyText = !isTextMime && media.data.length <= 512_000 && !media.data.some((b: number) => b < 0x09 || (b > 0x0d && b < 0x20 && b !== 0x1b));
        if (isTextMime || isLikelyText) {
          const content = media.data.toString("utf-8");
          promptText = (text || `O usuario enviou o arquivo "${fname}".`) + `\n\n[Conteúdo do arquivo "${fname}"]:\n${content}`;
        } else {
          const sizeKB = Math.round(media.data.length / 1024);
          promptText = (text || `O usuario enviou o arquivo "${fname}" (${docMime}, ${sizeKB}KB).`) + `\n\n[Arquivo anexado: "${fname}" (${docMime}, ${sizeKB}KB) — arquivo copiado ao workspace do agente]`;
        }
      } else {
        promptText = text || "";
      }

      // Show "typing" indicator
      await this.sock?.presenceSubscribe(chatJid);
      await this.sock?.sendPresenceUpdate("composing", chatJid);

      // ==================== Debounce: buffer text-only messages ====================
      // When users send rapid sequential texts (e.g. 2 messages in 5s), combine them
      // into a single message so only one classification/sub-agent is triggered.
      // Media messages (audio/image/document) flush any pending buffer and route immediately.
      const hasMedia = !!media;
      if (!hasMedia && promptText) {
        // Flush any pending buffer for this user if a media message arrives
        // (not the case here — this is text-only, so just buffer)
        const existing = this.pendingTexts.get(senderId);
        if (existing) {
          clearTimeout(existing.timer);
          existing.texts.push(promptText);
          if (quotedText && !existing.quotedText) existing.quotedText = quotedText;
          existing.timer = setTimeout(() => this.flushPendingTexts(senderId), WhatsAppConnector.TEXT_DEBOUNCE_MS);
          logger.info({ senderId, bufferedCount: existing.texts.length, debounceMs: WhatsAppConnector.TEXT_DEBOUNCE_MS }, "Buffered rapid text message");
        } else {
          this.pendingTexts.set(senderId, {
            texts: [promptText],
            timer: setTimeout(() => this.flushPendingTexts(senderId), WhatsAppConnector.TEXT_DEBOUNCE_MS),
            chatJid,
            senderId,
            user: user as any,
            quotedText: quotedText || undefined,
          });
          logger.info({ senderId, debounceMs: WhatsAppConnector.TEXT_DEBOUNCE_MS }, "Started text debounce window");
        }
        return;
      }

      // Media message — flush any pending text buffer first (prepend to this message)
      const flushedTexts = this.consumePendingTexts(senderId);
      if (flushedTexts && !hasMedia) {
        // Edge case: no media and no promptText — shouldn't happen, but guard
        promptText = flushedTexts;
      } else if (flushedTexts && hasMedia) {
        promptText = flushedTexts + "\n\n" + promptText;
      }

      // Build IncomingMessage and route through ConnectorManager
      // For images: pass as both media (for Gemini vision) and imageMedias (for sub-agent injection)
      const incomingImageMedias: MediaAttachment[] = [];
      if (media && imageInfo) incomingImageMedias.push(media);
      // For documents: pass as media (for main session) and also as imageMedias
      // so they get docker-cp'd into sub-agent containers via injectImages()
      if (media && docInfo) incomingImageMedias.push(media);

      const incoming: IncomingMessage = {
        connectorName: this.name,
        userId: senderId,
        numericUserId: user.id,
        userRole: user.role,
        userStatus: user.status,
        userName: user.displayName || pushName,
        text: promptText,
        media,
        imageMedias: incomingImageMedias.length > 0 ? incomingImageMedias : undefined,
        audioUrl,
        imageUrls: earlyImageUrl ? [earlyImageUrl] : undefined,
        fileInfos: earlyFileInfo ? [earlyFileInfo] : undefined,
        quotedText: quotedText || undefined,
        messageSaved: true, // already saved at line 472 for admin visibility
      };

      const response = await this.manager.handleIncomingMessage(incoming);

      // Send response and track it as AGENT (skip empty — sub-agents send async)
      if (response) {
        await this.sendTextMessage(chatJid, response);
      }

      // Stop typing AFTER sending the response to ensure the typing indicator
      // stays visible until the message is actually delivered.
      await this.sock?.sendPresenceUpdate("paused", chatJid);

      logger.info(
        { to: senderId, responseLength: response.length },
        "Response sent"
      );
    } catch (err) {
      logger.error({ err, msgId: msg.key.id }, "Error handling message");

      // Try to send error message back to the user
      const errChatJid = msg.key.remoteJid;
      if (errChatJid && !errChatJid.endsWith("@g.us")) {
        try {
          await this.sendTextMessage(
            errChatJid,
            "Desculpa, tive um erro processando sua mensagem. Tenta de novo?"
          );
        } catch {}
      }
    }
  }

  /**
   * Handle a poll vote update message.
   * Decrypts the vote and forwards selected options to the ConnectorManager.
   */
  private async handlePollUpdate(msg: any): Promise<void> {
    try {
      const inner = msg.message?.ephemeralMessage?.message || msg.message;
      const pollUpdate = inner?.pollUpdateMessage;
      if (!pollUpdate) return;

      const chatJid = msg.key.remoteJid || "";

      // Get the original poll creation message
      const pollCreationKey = pollUpdate.pollCreationMessageKey;
      if (!pollCreationKey?.id) return;

      const pollCreationMsg = this.pollMessages.get(pollCreationKey.id);
      if (!pollCreationMsg) {
        logger.warn({ pollKeyId: pollCreationKey.id }, "Poll creation message not found in cache");
        return;
      }

      // Get the messageSecret from the poll creation message
      const pollEncKey = (pollCreationMsg.message as any)?.messageContextInfo?.messageSecret
        || (pollCreationMsg as any).messageContextInfo?.messageSecret;

      if (!pollEncKey) {
        logger.warn("No messageSecret found on poll creation message");
        return;
      }

      // Decrypt the vote
      const voterJid = jidNormalizedUser(
        msg.key.participant || msg.key.remoteJid || ""
      );
      const pollCreatorJid = jidNormalizedUser(
        pollCreationKey.participant || pollCreationKey.remoteJid || ""
      );

      const decryptedVote = decryptPollVote(
        pollUpdate.vote,
        {
          pollCreatorJid,
          pollMsgId: pollCreationKey.id,
          pollEncKey,
          voterJid,
        }
      );

      if (!decryptedVote?.selectedOptions?.length) return;

      // Map SHA-256 hashes back to option names
      const pollContent = this.extractPollCreationContent(pollCreationMsg);
      if (!pollContent) return;

      const { createHash } = await import("node:crypto");
      const selectedNames: string[] = [];
      for (const hashBuf of decryptedVote.selectedOptions) {
        const hash = Buffer.from(hashBuf).toString("hex");
        for (const opt of pollContent.options) {
          const optHash = createHash("sha256").update(opt).digest("hex");
          if (optHash === hash) {
            selectedNames.push(opt);
            break;
          }
        }
      }

      if (selectedNames.length === 0) return;

      logger.info({ selectedNames, pollQuestion: pollContent.name }, "Poll vote received");

      // Resolve voter — prefer phone number over LID
      const voterPhone = this.resolvePhoneNumber(chatJid, msg.key.remoteJidAlt);
      await this.manager.handlePollVote(voterPhone, selectedNames);
    } catch (err) {
      logger.error({ err }, "Error handling poll update");
    }
  }

  // ==================== Debounce helpers ====================

  /**
   * Flush all buffered text messages for a user after the debounce window expires.
   * Combines all texts with newline, builds an IncomingMessage, and routes it
   * through the ConnectorManager as if it were a single message.
   */
  private async flushPendingTexts(senderId: string): Promise<void> {
    const entry = this.pendingTexts.get(senderId);
    if (!entry) return;
    this.pendingTexts.delete(senderId);

    const combinedText = entry.texts.join("\n");
    logger.info(
      { senderId, messageCount: entry.texts.length, combinedLength: combinedText.length },
      "Flushing debounced text messages"
    );

    try {
      const incoming: IncomingMessage = {
        connectorName: this.name,
        userId: entry.senderId,
        numericUserId: entry.user.id,
        userRole: entry.user.role as any,
        userStatus: entry.user.status as any,
        userName: entry.user.displayName || undefined,
        text: combinedText,
        quotedText: entry.quotedText,
        messageSaved: true, // individual messages already saved for admin visibility
      };

      const response = await this.manager.handleIncomingMessage(incoming);

      if (response) {
        await this.sendTextMessage(entry.chatJid, response);
      }
    } catch (err) {
      logger.error({ err, senderId }, "Error flushing debounced texts");
      try {
        await this.sendTextMessage(
          entry.chatJid,
          "Desculpa, tive um erro processando sua mensagem. Tenta de novo?"
        );
      } catch {}
    }

    // Stop typing after sending
    try {
      await this.sock?.sendPresenceUpdate("paused", entry.chatJid);
    } catch {}
  }

  /**
   * Consume (extract and clear) any pending buffered texts for a user.
   * Called when a media message arrives — the buffered texts are prepended
   * to the media message's prompt so they're not lost.
   * Returns the combined text, or null if no buffer existed.
   */
  private consumePendingTexts(senderId: string): string | null {
    const entry = this.pendingTexts.get(senderId);
    if (!entry) return null;

    clearTimeout(entry.timer);
    this.pendingTexts.delete(senderId);

    const combinedText = entry.texts.join("\n");
    logger.info(
      { senderId, messageCount: entry.texts.length },
      "Consumed pending texts for media message"
    );
    return combinedText;
  }

  // ==================== Internal helpers ====================

  private extractPollCreationContent(msg: WAMessage): { name: string; options: string[] } | null {
    const message = msg.message as any;
    if (!message) return null;

    const poll = message.pollCreationMessage
      || message.pollCreationMessageV2
      || message.pollCreationMessageV3;

    if (!poll) return null;

    const name = poll.name || "";
    const options = (poll.options || []).map((o: any) => o.optionName || "");
    return { name, options };
  }

  private isSelfChat(jid: string, _fromMe?: boolean): boolean {
    if (!this.myJid || !jid) return false;

    const myNumber = this.myJid.split(":")[0].split("@")[0];
    const chatNumber = jid.split("@")[0].split(":")[0];
    if (chatNumber === myNumber) return true;

    if (this.myLid && jid.endsWith("@lid")) {
      const myLidNumber = this.myLid.split(":")[0].split("@")[0];
      const chatLidNumber = jid.split(":")[0].split("@")[0];
      if (chatLidNumber === myLidNumber) return true;
    }

    return false;
  }

  private getMyPhone(): string {
    if (!this.myJid) return "unknown";
    return this.myJid.split(":")[0].split("@")[0];
  }

  private getSelfChatJid(): string | null {
    if (this.myLid) {
      const base = this.myLid.split(":")[0];
      return `${base}@lid`;
    }
    if (this.myJid) {
      const phone = this.myJid.split(":")[0].split("@")[0];
      return `${phone}@s.whatsapp.net`;
    }
    return null;
  }

  /**
   * Resolve the best phone-based identifier for a user.
   * Prefers phone number over LID to avoid duplicate users.
   *
   * Baileys v7 can use LID-based JIDs (@lid) as remoteJid. When that happens,
   * `remoteJidAlt` contains the phone-based JID (@s.whatsapp.net).
   * We can also query the internal signal mapping as a fallback.
   */
  private resolvePhoneNumber(primaryJid: string, altJid?: string): string {
    // Helper: extract bare number from a JID
    const bare = (jid: string) => jid.split("@")[0].split(":")[0];

    // 1. If altJid is a phone-based JID, use it
    if (altJid && altJid.includes("@s.whatsapp.net")) {
      return bare(altJid);
    }

    // 2. If primary is already phone-based, use it
    if (primaryJid.includes("@s.whatsapp.net")) {
      return bare(primaryJid);
    }

    // 3. If primary is LID, try the Baileys signal mapping
    if (primaryJid.includes("@lid") && this.sock) {
      try {
        const mapping = (this.sock as any).signalRepository?.lidMapping;
        if (mapping) {
          const pn = mapping.getPNForLID(primaryJid);
          if (pn && pn.includes("@s.whatsapp.net")) {
            return bare(pn);
          }
        }
      } catch {
        // Mapping not available — fall through
      }
    }

    // 4. Fallback: use the bare identifier (may be LID)
    return bare(primaryJid);
  }

  private extractText(msg: any): string | null {
    const message = msg.message;
    if (!message) return null;

    if (message.ephemeralMessage) {
      return this.extractText({ message: message.ephemeralMessage.message });
    }
    if (message.documentWithCaptionMessage) {
      return this.extractText({ message: message.documentWithCaptionMessage.message });
    }

    if (message.conversation) return message.conversation;
    if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
    if (message.imageMessage?.caption) return message.imageMessage.caption;
    if (message.videoMessage?.caption) return message.videoMessage.caption;
    if (message.documentMessage?.caption) return message.documentMessage.caption;

    return null;
  }

  private extractQuotedText(msg: any): string | null {
    const message = msg.message;
    if (!message) return null;

    const inner = message.ephemeralMessage?.message || message;

    const contentTypes = [
      "extendedTextMessage",
      "imageMessage",
      "videoMessage",
      "documentMessage",
      "audioMessage",
      "conversation",
    ];

    for (const ct of contentTypes) {
      const content = inner[ct];
      if (content?.contextInfo?.quotedMessage) {
        return this.extractTextFromMessage(content.contextInfo.quotedMessage);
      }
    }

    return null;
  }

  private extractTextFromMessage(message: any): string | null {
    if (!message) return null;

    if (message.conversation) return message.conversation;
    if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
    if (message.imageMessage?.caption) return message.imageMessage.caption;
    if (message.videoMessage?.caption) return message.videoMessage.caption;
    if (message.documentMessage?.caption) return message.documentMessage.caption;

    const poll = message.pollCreationMessage
      || message.pollCreationMessageV2
      || message.pollCreationMessageV3;
    if (poll?.name) {
      const opts = (poll.options || []).map((o: any) => o.optionName).join(", ");
      return `[Enquete: ${poll.name}] Opcoes: ${opts}`;
    }

    return null;
  }

  private extractAudioInfo(msg: any): { mimeType: string; seconds: number; ptt: boolean } | null {
    const message = msg.message;
    if (!message) return null;

    const inner = message.ephemeralMessage?.message || message;
    const audio = inner.audioMessage;

    if (!audio) return null;

    return {
      mimeType: audio.mimetype || "audio/ogg",
      seconds: audio.seconds || 0,
      ptt: !!audio.ptt,
    };
  }

  private extractImageInfo(msg: any): { mimeType: string } | null {
    const message = msg.message;
    if (!message) return null;

    const inner = message.ephemeralMessage?.message || message;
    const image = inner.imageMessage;

    if (!image) return null;

    return {
      mimeType: image.mimetype || "image/jpeg",
    };
  }

  private extractDocumentInfo(msg: any): { mimeType: string; fileName: string } | null {
    const message = msg.message;
    if (!message) return null;

    const inner = message.ephemeralMessage?.message || message;
    // documentWithCaptionMessage wraps a documentMessage inside .message
    const doc = inner.documentWithCaptionMessage?.message?.documentMessage
      || inner.documentMessage;

    if (!doc) return null;

    return {
      mimeType: doc.mimetype || "application/octet-stream",
      fileName: doc.fileName || "document",
    };
  }

  /**
   * Convert Markdown formatting to WhatsApp-compatible formatting.
   *
   * WhatsApp supports: *bold*, _italic_, ~strikethrough~, ```code```
   * LLMs typically output: **bold**, *italic*, ~~strike~~, `code`
   */
  private markdownToWhatsApp(text: string): string {
    let result = text;
    // Convert markdown bold **text** → WhatsApp bold *text*
    // Must be done before italic to avoid conflicts
    result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");
    // Convert markdown headers (### Title) → WhatsApp bold (*Title*)
    result = result.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");
    return result;
  }

  /**
   * Send a text message to a JID and track it as AGENT.
   */
  private async sendTextMessage(jid: string, text: string): Promise<void> {
    if (!this.sock) return;

    // Convert markdown formatting to WhatsApp-compatible formatting
    text = this.markdownToWhatsApp(text);

    const MAX_LENGTH = 4000;
    if (text.length <= MAX_LENGTH) {
      const sent = await this.sock.sendMessage(jid, { text });
      if (sent?.key?.id) {
        await this.memory.trackMessage(sent.key.id, "AGENT", text);
      }
    } else {
      const chunks = [];
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        chunks.push(text.slice(i, i + MAX_LENGTH));
      }
      for (const chunk of chunks) {
        const sent = await this.sock.sendMessage(jid, { text: chunk });
        if (sent?.key?.id) {
          await this.memory.trackMessage(sent.key.id, "AGENT", chunk);
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  /**
   * Send a poll message and cache it for later vote decryption.
   */
  private async sendPollMessage(jid: string, question: string, options: string[]): Promise<void> {
    if (!this.sock) return;

    const sent = await this.sock.sendMessage(jid, {
      poll: {
        name: question,
        values: options,
        selectableCount: 1,
      },
    });

    if (sent) {
      if (sent.key?.id) {
        if (this.pollMessages.size >= WhatsAppConnector.MAX_POLL_MESSAGES) {
          const oldest = this.pollMessages.keys().next().value;
          if (oldest) this.pollMessages.delete(oldest);
        }
        this.pollMessages.set(sent.key.id, sent);
        await this.memory.trackMessage(sent.key.id, "AGENT", `[Enquete: ${question}] ${options.join(" | ")}`);
        logger.info({ pollId: sent.key.id, question, options }, "Poll sent");
      }
    }
  }
}
