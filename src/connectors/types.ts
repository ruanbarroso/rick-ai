import type { MediaAttachment } from "../llm/types.js";
import type { UserRole, UserStatus } from "../auth/permissions.js";

/**
 * A message coming from any connector into the Agent.
 */
export interface IncomingMessage {
  /** Which connector sent this message */
  connectorName: string;
  /**
   * User identifier.
   * - Legacy: phone number string (pre-RBAC)
   * - RBAC: numeric user ID as string (post-RBAC)
   */
  userId: string;
  /** Numeric user ID from the users table (RBAC). */
  numericUserId?: number;
  /** User's role in the RBAC system. null = pending (no access). */
  userRole?: UserRole;
  /** User's status in the RBAC system. */
  userStatus?: UserStatus;
  /** Display name of the user, if known */
  userName?: string;
  /** Text content of the message */
  text: string;
  /** Optional media attachment (audio, image, file) */
  media?: MediaAttachment;
  /** Separate image media when audio is the primary media (audio+image combo) */
  imageMedias?: MediaAttachment[];
  /** URL to the stored audio blob (for playback in chat history) */
  audioUrl?: string;
  /** URLs to stored image blobs (for display in chat history) */
  imageUrls?: string[];
  /** Generic file attachments (non-image/audio) for display in chat history */
  fileInfos?: Array<{ url: string; name: string; mimeType: string }>;
  /** Quoted/replied-to text, if this is a reply */
  quotedText?: string;
  /**
   * When true, skip sub-agent relay interception and go straight to simple chat.
   * Used by Web UI when the user is explicitly in the main session — sub-agents
   * have their own dedicated UI panels for follow-up messages.
   */
  skipSubAgentRelay?: boolean;
  /**
   * When true, the connector has already persisted this message to the conversations
   * table. The Agent should skip its own save to avoid duplicates.
   * Used by WhatsApp connector which saves messages early for admin visibility
   * (blocked/pending users still appear in history).
   */
  messageSaved?: boolean;
}

/**
 * Capabilities a connector can support. Not all connectors support all features.
 * The Agent checks these to decide what to send.
 */
export interface ConnectorCapabilities {
  /** Can send polls (WhatsApp-specific) */
  polls: boolean;
  /** Can show typing indicators */
  typing: boolean;
  /** Can receive media attachments */
  media: boolean;
  /** Can render markdown-like formatting */
  richText: boolean;
}

/**
 * Optional metadata for outgoing messages.
 * Connectors that understand these fields can use them (e.g., Web UI routes
 * messages to sub-agent sessions via sessionId). Connectors that don't
 * understand them simply ignore the extra parameter.
 */
export interface SendMessageOptions {
  /** Sub-agent session ID — Web UI uses this to route messages to the correct session panel */
  sessionId?: string;
  /**
   * Type of the agent message.
   * - "text"     → normal assistant response (type 2)
   * - "tool_use" → tool execution notification (type 3); some connectors (e.g. WhatsApp) filter these out
   */
  messageType?: "text" | "tool_use";
}

/**
 * Interface that all connectors must implement.
 *
 * A connector is a bridge between an external messaging platform (WhatsApp, Web,
 * Discord, Telegram, etc.) and the Agent core. It handles:
 * - Receiving messages from the platform and forwarding them to the Agent
 * - Sending Agent responses back to the platform
 * - Platform-specific lifecycle (connection, auth, QR codes, etc.)
 */
export interface Connector {
  /** Unique name for this connector (e.g., "whatsapp", "web", "discord") */
  readonly name: string;

  /** What this connector supports */
  readonly capabilities: ConnectorCapabilities;

  /**
   * Start the connector. Called once during bootstrap.
   * Should establish connection to the platform and begin listening for messages.
   */
  start(): Promise<void>;

  /**
   * Stop the connector gracefully. Called during shutdown.
   */
  stop(): Promise<void>;

  /**
   * Send a text message to the user via this connector.
   * @param options - Optional metadata (e.g., sessionId for sub-agent routing).
   */
  sendMessage(userId: string, text: string, options?: SendMessageOptions): Promise<void>;

  /**
   * Send a poll/choice to the user. Optional — only if capabilities.polls is true.
   */
  sendPoll?(userId: string, question: string, options: string[]): Promise<void>;

  /**
   * Set typing indicator. Optional — only if capabilities.typing is true.
   */
  setTyping?(userId: string, composing: boolean): Promise<void>;
}

/**
 * Callback signature for when a connector receives a message from the user.
 * The connector calls this to forward the message to the Agent.
 */
export type OnMessageCallback = (msg: IncomingMessage) => Promise<string>;

/**
 * Callback signature for when a connector receives a poll vote.
 * WhatsApp-specific, but abstracted so Agent doesn't import WhatsApp types.
 */
export type OnPollVoteCallback = (userId: string, selectedOptions: string[]) => Promise<void>;
