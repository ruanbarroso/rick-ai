import { query } from "./db.js";
import { isPostgres } from "./database.js";
import { logger } from "../config/logger.js";
import { config } from "../config/env.js";
import { encryptValue, decryptValue, isSensitiveCategory } from "./crypto.js";
import type { UserRole } from "../auth/permissions.js";
import { hasAuthorityOver } from "../auth/permissions.js";

export interface Memory {
  id: number;
  user_phone: string;
  category: string;
  key: string;
  value: string;
  metadata: Record<string, any>;
  created_by: number | null;
  created_at: Date;
  updated_at: Date;
}

/** Result of a memory write attempt (RBAC-aware). */
export interface RememberResult {
  saved: boolean;
  /** Write was blocked due to hierarchy (admin > dev). */
  blocked?: boolean;
  /** The existing value that prevented the write. */
  existingValue?: string;
  /** The memory that was saved or that blocked the write. */
  memory?: Memory;
}

export interface FileInfo {
  url: string;
  name: string;
  mimeType: string;
}

export interface ConversationMessage {
  role: "user" | "assistant" | "system";
  content: string;
  created_at?: string;
  message_type?: "text" | "tool_use";
  audio_url?: string;
  image_urls?: string[];
  file_infos?: FileInfo[];
}

export class MemoryService {
  // ==================== MEMORY CRUD ====================

  /**
   * Save a memory (legacy — no RBAC checks).
   * @deprecated Use rememberV2() for RBAC-aware writes.
   */
  async remember(
    userPhone: string,
    key: string,
    value: string,
    category: string = "general",
    metadata: Record<string, any> = {}
  ): Promise<Memory> {
    // Encrypt values in sensitive categories (credentials, passwords, etc.)
    const storedValue = isSensitiveCategory(category) ? encryptValue(value) : value;

    const result = await query(
      `INSERT INTO memories (user_phone, category, key, value, metadata)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_phone, category, key)
       DO UPDATE SET value = $4, metadata = $5, updated_at = NOW()
       RETURNING *`,
      [userPhone, category, key, storedValue, JSON.stringify(metadata)]
    );
    logger.info({ userPhone, category, key }, "Memory saved");
    // Return with decrypted value so callers see plaintext
    const row = result.rows[0];
    row.value = decryptValue(row.value);
    return row;
  }

  /**
   * Save a memory with RBAC hierarchy enforcement.
   *
   * Rules:
   *   - If a memory with the same (category, key) exists and was created by
   *     a user with higher authority, the write is BLOCKED.
   *   - Otherwise, the memory is created/updated with created_by tracking.
   *
   * @param key - Memory key
   * @param value - Memory value
   * @param category - Memory category (default: "general")
   * @param requestingUserId - ID of the user making the change
   * @param requestingUserRole - Role of the user making the change
   * @param metadata - Optional metadata JSON
   */
  async rememberV2(
    key: string,
    value: string,
    category: string = "general",
    requestingUserId: number,
    requestingUserRole: UserRole,
    metadata: Record<string, any> = {}
  ): Promise<RememberResult> {
    // Check for existing memory with this key
    const existing = await query(
      `SELECT m.*, u.role as creator_role FROM memories m
       LEFT JOIN users u ON u.id = m.created_by
       WHERE m.category = $1 AND LOWER(m.key) = LOWER($2)
       LIMIT 1`,
      [category, key]
    );

    if (existing.rows.length > 0) {
      const existingRow = existing.rows[0];
      const creatorRole = existingRow.creator_role as UserRole;

      // Hierarchy check: can this user overwrite this memory?
      if (creatorRole && !hasAuthorityOver(requestingUserRole, creatorRole)) {
        const decryptedValue = decryptValue(existingRow.value);
        logger.info(
          { category, key, requestingUserRole, creatorRole },
          "Memory write blocked by hierarchy"
        );
        return {
          saved: false,
          blocked: true,
          existingValue: decryptedValue,
        };
      }
    }

    // Encrypt if sensitive
    const storedValue = isSensitiveCategory(category) ? encryptValue(value) : value;

    // Upsert using global unique constraint (category, key)
    const result = await query(
      `INSERT INTO memories (category, key, value, metadata, created_by, user_id, user_phone)
       VALUES ($1, $2, $3, $4, $5, $5, '')
       ON CONFLICT (category, key)
       DO UPDATE SET value = $3, metadata = $4, created_by = $5, updated_at = NOW()
       RETURNING *`,
      [category, key, storedValue, JSON.stringify(metadata), requestingUserId]
    );

    logger.info(
      { category, key, createdBy: requestingUserId },
      "Memory saved (RBAC)"
    );

    const row = result.rows[0];
    row.value = decryptValue(row.value);
    return { saved: true, memory: row };
  }

  /**
   * Decrypt all memory values in a result set (sensitive categories may be encrypted).
   */
  private decryptMemories(memories: Memory[]): Memory[] {
    for (const mem of memories) {
      mem.value = decryptValue(mem.value);
    }
    return memories;
  }

  async recall(
    userPhone: string,
    searchTerm: string
  ): Promise<Memory[]> {
    // First try exact key match
    let result = await query(
      `SELECT * FROM memories 
       WHERE user_phone = $1 AND LOWER(key) = LOWER($2)
       ORDER BY updated_at DESC`,
      [userPhone, searchTerm]
    );

    if (result.rows.length > 0) return this.decryptMemories(result.rows);

    // Then try full-text search (PostgreSQL only — SQLite skips to LIKE)
    // NOTE: Full-text search won't match encrypted values — this is by design.
    // Encrypted credentials are found via exact key match above.
    if (isPostgres()) {
      result = await query(
        `SELECT *, ts_rank(
          to_tsvector('portuguese', key || ' ' || value),
          plainto_tsquery('portuguese', $2)
         ) as rank
         FROM memories 
         WHERE user_phone = $1 
           AND to_tsvector('portuguese', key || ' ' || value) @@ plainto_tsquery('portuguese', $2)
         ORDER BY rank DESC
         LIMIT 10`,
        [userPhone, searchTerm]
      );

      if (result.rows.length > 0) return this.decryptMemories(result.rows);
    }

    // Fallback to LIKE (ILIKE on PG, LIKE on SQLite — adapter handles it)
    result = await query(
      `SELECT * FROM memories 
       WHERE user_phone = $1 
         AND (key ILIKE $2 OR value ILIKE $2)
       ORDER BY updated_at DESC
       LIMIT 10`,
      [userPhone, `%${searchTerm}%`]
    );

    return this.decryptMemories(result.rows);
  }

  async forget(
    userPhone: string,
    key: string,
    category?: string
  ): Promise<number> {
    let result;
    if (category) {
      result = await query(
        `DELETE FROM memories 
         WHERE user_phone = $1 AND LOWER(key) = LOWER($2) AND category = $3`,
        [userPhone, key, category]
      );
    } else {
      result = await query(
        `DELETE FROM memories 
         WHERE user_phone = $1 AND LOWER(key) = LOWER($2)`,
        [userPhone, key]
      );
    }
    logger.info(
      { userPhone, key, deleted: result.rowCount },
      "Memory forgotten"
    );
    return result.rowCount || 0;
  }

  async forgetCategory(
    userPhone: string,
    category: string
  ): Promise<number> {
    const result = await query(
      `DELETE FROM memories WHERE user_phone = $1 AND category = $2`,
      [userPhone, category]
    );
    return result.rowCount || 0;
  }

  async forgetAll(userPhone: string): Promise<number> {
    const result = await query(
      `DELETE FROM memories WHERE user_phone = $1`,
      [userPhone]
    );
    return result.rowCount || 0;
  }

  async listMemories(
    userPhone: string,
    category?: string
  ): Promise<Memory[]> {
    if (category) {
      const result = await query(
        `SELECT * FROM memories 
         WHERE user_phone = $1 AND category = $2
         ORDER BY category, key`,
        [userPhone, category]
      );
      return this.decryptMemories(result.rows);
    }

    const result = await query(
      `SELECT * FROM memories 
       WHERE user_phone = $1
       ORDER BY category, key`,
      [userPhone]
    );
    return this.decryptMemories(result.rows);
  }

  // ==================== RBAC-AWARE MEMORY QUERIES ====================

  /**
   * Search global memories (no user filter).
   */
  async recallGlobal(searchTerm: string): Promise<Memory[]> {
    // Exact key match
    let result = await query(
      `SELECT * FROM memories WHERE LOWER(key) = LOWER($1) ORDER BY updated_at DESC`,
      [searchTerm]
    );
    if (result.rows.length > 0) return this.decryptMemories(result.rows);

    // Full-text search (PostgreSQL only)
    if (isPostgres()) {
      result = await query(
        `SELECT *, ts_rank(
          to_tsvector('portuguese', key || ' ' || value),
          plainto_tsquery('portuguese', $1)
         ) as rank
         FROM memories
         WHERE to_tsvector('portuguese', key || ' ' || value) @@ plainto_tsquery('portuguese', $1)
         ORDER BY rank DESC
         LIMIT 10`,
        [searchTerm]
      );
      if (result.rows.length > 0) return this.decryptMemories(result.rows);
    }

    // LIKE fallback
    result = await query(
      `SELECT * FROM memories
       WHERE (key ILIKE $1 OR value ILIKE $1)
       ORDER BY updated_at DESC
       LIMIT 10`,
      [`%${searchTerm}%`]
    );
    return this.decryptMemories(result.rows);
  }

  /**
   * List all global memories, optionally filtered by category.
   */
  async listGlobalMemories(category?: string): Promise<Memory[]> {
    if (category) {
      const result = await query(
        `SELECT * FROM memories WHERE category = $1 ORDER BY category, key`,
        [category]
      );
      return this.decryptMemories(result.rows);
    }
    const result = await query(
      `SELECT * FROM memories ORDER BY category, key`
    );
    return this.decryptMemories(result.rows);
  }

  /**
   * Delete a global memory by key (optionally filtered by category).
   */
  async forgetGlobal(key: string, category?: string): Promise<number> {
    let result;
    if (category) {
      result = await query(
        `DELETE FROM memories WHERE LOWER(key) = LOWER($1) AND category = $2`,
        [key, category]
      );
    } else {
      result = await query(
        `DELETE FROM memories WHERE LOWER(key) = LOWER($1)`,
        [key]
      );
    }
    logger.info({ key, category, deleted: result.rowCount }, "Global memory forgotten");
    return result.rowCount || 0;
  }

  /**
   * Delete all global memories.
   */
  async forgetAllGlobal(): Promise<number> {
    const result = await query(`DELETE FROM memories`);
    return result.rowCount || 0;
  }

  /**
   * Build memory context for LLM system prompt (global memories).
   * Filters out sensitive categories for non-admin users.
   */
  async buildGlobalMemoryContext(role: UserRole): Promise<string> {
    const memories = await this.listGlobalMemories();
    if (memories.length === 0) return "";

    const grouped: Record<string, Memory[]> = {};
    for (const mem of memories) {
      // Filter out sensitive categories for non-admin users
      if (role !== "admin" && isSensitiveCategory(mem.category)) continue;
      if (!grouped[mem.category]) grouped[mem.category] = [];
      grouped[mem.category].push(mem);
    }

    if (Object.keys(grouped).length === 0) return "";

    let context = "\n--- MEMORIAS DO RICK ---\n";
    for (const [category, mems] of Object.entries(grouped)) {
      context += `\n[${category.toUpperCase()}]\n`;
      for (const mem of mems) {
        context += `- ${mem.key}: ${mem.value}\n`;
      }
    }
    context += "--- FIM DAS MEMORIAS ---\n";

    return context;
  }

  // ==================== CONVERSATION HISTORY ====================

  /**
   * Maximum number of conversation messages to keep per user.
   * Older messages are pruned automatically after each insert.
   */
  private static readonly MAX_CONVERSATION_MESSAGES = 500;

  /**
   * Maximum number of message_log entries to keep (global, not per-user).
   * Pruned periodically, not on every insert.
   */
  private static readonly MAX_MESSAGE_LOG_ENTRIES = 5000;

  /** Counter to throttle message_log cleanup (run every ~100 saves) */
  private saveCounter = 0;

  async saveMessage(
    userPhone: string,
    role: "user" | "assistant",
    content: string,
    modelUsed?: string,
    tokensUsed?: number,
    audioUrl?: string,
    imageUrls?: string[],
    messageType?: "text" | "tool_use",
    fileInfos?: FileInfo[]
  ): Promise<void> {
    // Store image URLs as JSON array string in image_url column
    const imageUrlValue = imageUrls && imageUrls.length > 0 ? JSON.stringify(imageUrls) : null;
    const fileInfosValue = fileInfos && fileInfos.length > 0 ? JSON.stringify(fileInfos) : null;
    await query(
      `INSERT INTO conversations (user_phone, role, content, model_used, tokens_used, audio_url, image_url, message_type, file_infos)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [userPhone, role, content, modelUsed || null, tokensUsed || null, audioUrl || null, imageUrlValue, messageType || "text", fileInfosValue]
    );

    // Prune old conversation messages for this user (keep most recent N)
    this.saveCounter++;
    if (this.saveCounter % 20 === 0) {
      // Run cleanup every 20 messages to avoid per-insert overhead
      query(
        `DELETE FROM conversations WHERE user_phone = $1 AND id NOT IN (
           SELECT id FROM conversations WHERE user_phone = $1 ORDER BY created_at DESC LIMIT $2
         )`,
        [userPhone, MemoryService.MAX_CONVERSATION_MESSAGES]
      ).catch((err) => logger.warn({ err }, "Conversation pruning failed"));
    }

    // Prune message_log every ~100 saves
    if (this.saveCounter % 100 === 0) {
      query(
        `DELETE FROM message_log WHERE id NOT IN (
           SELECT id FROM message_log ORDER BY created_at DESC LIMIT $1
         )`,
        [MemoryService.MAX_MESSAGE_LOG_ENTRIES]
      ).catch((err) => logger.warn({ err }, "Message log pruning failed"));
    }
  }

  async getConversationHistory(
    userPhone: string,
    limit?: number
  ): Promise<ConversationMessage[]> {
    const maxMessages = limit || config.conversationHistoryLimit;
    const result = await query(
      `SELECT role, content, created_at, audio_url, image_url, message_type, file_infos FROM conversations
       WHERE user_phone = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userPhone, maxMessages]
    );
    // Parse image_url: could be JSON array string or legacy single URL
    return result.rows.reverse().map((row: any) => {
      const msg: ConversationMessage = { role: row.role, content: row.content };
      if (row.created_at) msg.created_at = row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at;
      if (row.message_type) msg.message_type = row.message_type;
      if (row.audio_url) msg.audio_url = row.audio_url;
      if (row.image_url) {
        try {
          const parsed = JSON.parse(row.image_url);
          msg.image_urls = Array.isArray(parsed) ? parsed : [row.image_url];
        } catch {
          // Legacy single URL string
          msg.image_urls = [row.image_url];
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
  }

  async clearConversation(userPhone: string): Promise<void> {
    await query(`DELETE FROM conversations WHERE user_phone = $1`, [
      userPhone,
    ]);
  }

  // ==================== RBAC-AWARE CONVERSATION METHODS ====================

  /**
   * Save a message using user_id instead of user_phone.
   */
  async saveMessageByUserId(
    userId: number,
    role: "user" | "assistant",
    content: string,
    modelUsed?: string,
    tokensUsed?: number,
    audioUrl?: string,
    imageUrls?: string[],
    messageType?: "text" | "tool_use",
    fileInfos?: FileInfo[]
  ): Promise<void> {
    const imageUrlValue = imageUrls && imageUrls.length > 0 ? JSON.stringify(imageUrls) : null;
    const fileInfosValue = fileInfos && fileInfos.length > 0 ? JSON.stringify(fileInfos) : null;
    await query(
      `INSERT INTO conversations (user_id, user_phone, role, content, model_used, tokens_used, audio_url, image_url, message_type, file_infos)
       VALUES ($1, '', $2, $3, $4, $5, $6, $7, $8, $9)`,
      [userId, role, content, modelUsed || null, tokensUsed || null, audioUrl || null, imageUrlValue, messageType || "text", fileInfosValue]
    );

    this.saveCounter++;
    if (this.saveCounter % 20 === 0) {
      query(
        `DELETE FROM conversations WHERE user_id = $1 AND id NOT IN (
           SELECT id FROM conversations WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2
         )`,
        [userId, MemoryService.MAX_CONVERSATION_MESSAGES]
      ).catch((err) => logger.warn({ err }, "Conversation pruning failed"));
    }

    if (this.saveCounter % 100 === 0) {
      query(
        `DELETE FROM message_log WHERE id NOT IN (
           SELECT id FROM message_log ORDER BY created_at DESC LIMIT $1
         )`,
        [MemoryService.MAX_MESSAGE_LOG_ENTRIES]
      ).catch((err) => logger.warn({ err }, "Message log pruning failed"));
    }
  }

  /**
   * Get conversation history by user_id.
   */
  async getConversationHistoryByUserId(
    userId: number,
    limit?: number
  ): Promise<ConversationMessage[]> {
    const maxMessages = limit || config.conversationHistoryLimit;
    const result = await query(
      `SELECT role, content, created_at, audio_url, image_url, message_type, file_infos FROM conversations
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, maxMessages]
    );
    return result.rows.reverse().map((row: any) => {
      const msg: ConversationMessage = { role: row.role, content: row.content };
      if (row.created_at) msg.created_at = row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at;
      if (row.message_type) msg.message_type = row.message_type;
      if (row.audio_url) msg.audio_url = row.audio_url;
      if (row.image_url) {
        try {
          const parsed = JSON.parse(row.image_url);
          msg.image_urls = Array.isArray(parsed) ? parsed : [row.image_url];
        } catch {
          msg.image_urls = [row.image_url];
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
  }

  /**
   * Clear conversation history by user_id.
   */
  async clearConversationByUserId(userId: number): Promise<void> {
    await query(`DELETE FROM conversations WHERE user_id = $1`, [userId]);
  }

  // ==================== USER MANAGEMENT ====================

  async getOrCreateUser(
    phone: string,
    name?: string
  ): Promise<{
    id: number;
    phone: string;
    name: string | null;
    is_owner: boolean;
  }> {
    // Try to get existing user
    let result = await query(`SELECT * FROM users WHERE phone = $1`, [
      phone,
    ]);

    if (result.rows.length > 0) {
      // Update name if provided and different
      if (name && name !== result.rows[0].name) {
        await query(
          `UPDATE users SET name = $1, updated_at = NOW() WHERE phone = $2`,
          [name, phone]
        );
        result.rows[0].name = name;
      }
      return result.rows[0];
    }

    // Create new user
    const isOwner =
      config.ownerPhone !== "" && phone.includes(config.ownerPhone);
    result = await query(
      `INSERT INTO users (phone, name, is_owner) VALUES ($1, $2, $3) RETURNING *`,
      [phone, name || null, isOwner]
    );
    logger.info({ phone, isOwner }, "New user created");
    return result.rows[0];
  }

  // ==================== CONTEXT BUILDING ====================

  async buildMemoryContext(userPhone: string): Promise<string> {
    const memories = await this.listMemories(userPhone);
    if (memories.length === 0) return "";

    const grouped: Record<string, Memory[]> = {};
    for (const mem of memories) {
      if (!grouped[mem.category]) grouped[mem.category] = [];
      grouped[mem.category].push(mem);
    }

    let context = "\n--- MEMORIAS DO USUARIO ---\n";
    for (const [category, mems] of Object.entries(grouped)) {
      context += `\n[${category.toUpperCase()}]\n`;
      for (const mem of mems) {
        context += `- ${mem.key}: ${mem.value}\n`;
      }
    }
    context += "--- FIM DAS MEMORIAS ---\n";

    return context;
  }

  // ==================== MESSAGE TRACKING ====================

  async trackMessage(
    waMessageId: string,
    author: "AGENT" | "USER",
    content: string
  ): Promise<void> {
    await query(
      `INSERT INTO message_log (wa_message_id, author, content)
       VALUES ($1, $2, $3)
       ON CONFLICT (wa_message_id) DO NOTHING`,
      [waMessageId, author, content]
    );
  }

  async isAgentMessage(waMessageId: string): Promise<boolean> {
    const result = await query(
      `SELECT author FROM message_log WHERE wa_message_id = $1`,
      [waMessageId]
    );
    return result.rows.length > 0 && result.rows[0].author === "AGENT";
  }

  async messageExists(waMessageId: string): Promise<boolean> {
    const result = await query(
      `SELECT 1 FROM message_log WHERE wa_message_id = $1`,
      [waMessageId]
    );
    return result.rows.length > 0;
  }

  // ==================== AUDIO BLOBS ====================

  /**
   * Store an audio blob and return its ID.
   * ID is a random 16-char hex string.
   */
  async saveAudioBlob(data: Buffer, mimeType: string): Promise<string> {
    const id = Array.from(crypto.getRandomValues(new Uint8Array(8)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    await query(
      `INSERT INTO audio_blobs (id, data, mime_type) VALUES ($1, $2, $3)`,
      [id, data, mimeType]
    );
    return id;
  }

  /**
   * Retrieve an audio blob by ID.
   */
  async getAudioBlob(id: string): Promise<{ data: Buffer; mimeType: string } | null> {
    const result = await query(
      `SELECT data, mime_type FROM audio_blobs WHERE id = $1`,
      [id]
    );
    if (result.rows.length === 0) return null;
    return { data: result.rows[0].data, mimeType: result.rows[0].mime_type };
  }
}
