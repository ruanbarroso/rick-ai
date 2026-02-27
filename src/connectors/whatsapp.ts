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
import { MediaAttachment } from "../llm/types.js";
import { logger } from "../config/logger.js";
import { config } from "../config/env.js";

const AUTH_DIR = path.join(process.cwd(), "auth_info");

/**
 * WhatsApp connector using Baileys v7.
 *
 * Implements the Connector interface so the Agent can communicate
 * through WhatsApp without knowing anything about Baileys internals.
 *
 * Self-chat only: messages from other chats are silently ignored.
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
  private myJid: string | null = null;
  private myLid: string | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private manualDisconnectInProgress = false;
  private processing = new Set<string>();

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
   * Callback for QR code events — allows the web connector or other
   * consumers to receive QR codes for display.
   */
  private qrListeners: Array<(qr: string) => void> = [];
  private statusListeners: Array<(connected: boolean) => void> = [];

  constructor(manager: ConnectorManager, memory: MemoryService) {
    this.manager = manager;
    this.memory = memory;
  }

  // ==================== Connector interface ====================

  async start(): Promise<void> {
    if (this.sock !== null) {
      logger.warn("WhatsApp connector já está iniciando ou conectado, ignorando start() duplicado.");
      return;
    }

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

    try {
      if (this.sock) {
        await this.sock.logout();
      }
    } catch (err) {
      logger.warn({ err }, "WhatsApp logout failed, forcing disconnect");
    }

    await this.stop();
    await fs.rm(AUTH_DIR, { recursive: true, force: true });
    this.reconnectAttempts = 0;
    await this.start();
  }

  async sendMessage(userId: string, text: string, options?: SendMessageOptions): Promise<void> {
    // Mensagens de tool execution (tipo 3) não devem ser enviadas ao WhatsApp
    if (options?.messageType === "tool_use") {
      logger.debug({ userId }, "WhatsApp: skipping tool_use message");
      return;
    }
    const jid = this.getSelfChatJid();
    if (!jid || !this.sock) {
      logger.warn("WhatsApp: cannot send message — not connected");
      return;
    }
    await this.sendTextMessage(jid, text);
  }

  async sendPoll(userId: string, question: string, options: string[]): Promise<void> {
    const jid = this.getSelfChatJid();
    if (!jid || !this.sock) return;
    await this.sendPollMessage(jid, question, options);
  }

  async setTyping(userId: string, composing: boolean): Promise<void> {
    const jid = this.getSelfChatJid();
    if (!jid || !this.sock) return;

    try {
      await this.sock.presenceSubscribe(jid);
      await this.sock.sendPresenceUpdate(composing ? "composing" : "paused", jid);
    } catch (err) {
      logger.warn({ err }, "Failed to update WhatsApp presence");
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

      // Check for poll update (vote) messages
      const inner = msg.message.ephemeralMessage?.message || msg.message;
      if (inner.pollUpdateMessage) {
        await this.handlePollUpdate(msg);
        return;
      }

      // Extract text, detect audio and image
      const text = this.extractText(msg);
      const audioInfo = this.extractAudioInfo(msg);
      const imageInfo = this.extractImageInfo(msg);

      // Skip if no text, audio, or image
      if (!text && !audioInfo && !imageInfo) return;

      // Dedup: skip if already being processed
      if (this.processing.has(msgId)) return;
      this.processing.add(msgId);
      setTimeout(() => this.processing.delete(msgId), 60000);

      // Check if this message was sent by the AGENT (already in DB)
      const isFromAgent = await this.memory.isAgentMessage(msgId);
      if (isFromAgent) return;

      // Only process messages from self-chat (you messaging yourself)
      const isSelf = this.isSelfChat(chatJid, fromMe);
      if (!isSelf) return;

      // Track message
      const trackText = text || (audioInfo ? "[audio]" : "[imagem]");
      await this.memory.trackMessage(msgId, "USER", trackText);

      const userPhone = this.getMyPhone();
      const pushName = msg.pushName || undefined;

      // Extract quoted message text (if user replied to a message)
      const quotedText = this.extractQuotedText(msg);

      // Download media if present (audio or image)
      let media: MediaAttachment | undefined;
      if (audioInfo) {
        try {
          const buffer = await downloadMediaMessage(msg, "buffer", {});
          media = {
            data: buffer as Buffer,
            mimeType: audioInfo.mimeType,
          };
          logger.info(
            { from: "USER", type: "audio", seconds: audioInfo.seconds, ptt: audioInfo.ptt },
            "Audio message received"
          );
        } catch (err) {
          logger.error({ err }, "Failed to download audio");
          const jid = this.getSelfChatJid();
          if (jid) await this.sendTextMessage(jid, "Nao consegui baixar o audio. Tenta enviar de novo?");
          return;
        }
      } else if (imageInfo) {
        try {
          const buffer = await downloadMediaMessage(msg, "buffer", {});
          media = {
            data: buffer as Buffer,
            mimeType: imageInfo.mimeType,
          };
          logger.info(
            { from: "USER", type: "image", mimeType: imageInfo.mimeType, hasCaption: !!text },
            "Image message received"
          );
        } catch (err) {
          logger.error({ err }, "Failed to download image");
          const jid = this.getSelfChatJid();
          if (jid) await this.sendTextMessage(jid, "Nao consegui baixar a imagem. Tenta enviar de novo?");
          return;
        }
      } else {
        logger.info(
          {
            from: "USER",
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
      } else {
        promptText = text || "";
      }

      // Show "typing" indicator
      await this.sock?.presenceSubscribe(chatJid);
      await this.sock?.sendPresenceUpdate("composing", chatJid);

      // Build IncomingMessage and route through ConnectorManager
      const incoming: IncomingMessage = {
        connectorName: this.name,
        userId: userPhone,
        userName: pushName,
        text: promptText,
        media,
        quotedText: quotedText || undefined,
      };

      const response = await this.manager.handleIncomingMessage(incoming);

      // Stop typing
      await this.sock?.sendPresenceUpdate("paused", chatJid);

      // Send response and track it as AGENT (skip empty — edit mode sends async)
      if (response) {
        await this.sendTextMessage(chatJid, response);
      }

      logger.info(
        { to: "USER", responseLength: response.length },
        "Response sent"
      );
    } catch (err) {
      logger.error({ err, msgId: msg.key.id }, "Error handling message");

      const errChatJid = msg.key.remoteJid;
      if (errChatJid && this.isSelfChat(errChatJid, true)) {
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
      if (!this.isSelfChat(chatJid, msg.key.fromMe)) return;

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

      const userPhone = this.getMyPhone();
      await this.manager.handlePollVote(userPhone, selectedNames);
    } catch (err) {
      logger.error({ err }, "Error handling poll update");
    }
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

  /**
   * Send a text message to a JID and track it as AGENT.
   */
  private async sendTextMessage(jid: string, text: string): Promise<void> {
    if (!this.sock) return;

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
