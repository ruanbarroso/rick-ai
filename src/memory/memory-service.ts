import { query } from "./db.js";
import { isPostgres } from "./database.js";
import { logger } from "../config/logger.js";
import { config } from "../config/env.js";
import { encryptValue, decryptValue, isSensitiveCategory } from "./crypto.js";
import type { UserRole } from "../auth/permissions.js";
import { hasAuthorityOver } from "../auth/permissions.js";
import { EmbeddingService } from "./embedding-service.js";

export interface Memory {
  id: number;
  category: string;
  key: string;
  value: string;
  metadata: Record<string, any>;
  importance: number;
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
  connector_name?: string;
}

export class MemoryService {
  // ==================== MEMORY CRUD ====================

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
    metadata: Record<string, any> = {},
    importance: number = 5
  ): Promise<RememberResult> {
    // Clamp importance to 1-10
    const clampedImportance = Math.max(1, Math.min(10, Math.round(importance)));

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

      // Save previous value to history before overwriting
      try {
        const oldValue = decryptValue(existingRow.value);
        await query(
          `INSERT INTO memory_history (memory_id, category, key, old_value, new_value, changed_by)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [existingRow.id, category, key, oldValue, value, requestingUserId]
        );
      } catch (err) {
        // Non-fatal — history table may not exist yet during migration
        logger.debug({ err }, "Failed to save memory history (non-fatal)");
      }
    }

    // Encrypt if sensitive
    const storedValue = isSensitiveCategory(category) ? encryptValue(value) : value;

    // Upsert using global unique constraint (category, key)
    const result = await query(
      `INSERT INTO memories (category, key, value, metadata, created_by, user_id, importance)
       VALUES ($1, $2, $3, $4, $5, $5, $6)
       ON CONFLICT (category, key)
       DO UPDATE SET value = $3, metadata = $4, created_by = $5, importance = $6, updated_at = NOW()
       RETURNING *`,
      [category, key, storedValue, JSON.stringify(metadata), requestingUserId, clampedImportance]
    );

    logger.info(
      { category, key, importance: clampedImportance, createdBy: requestingUserId },
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
   *
   * @deprecated Use buildRelevantMemoryContext() for query-aware filtering.
   */
  async buildGlobalMemoryContext(role: UserRole): Promise<string> {
    const memories = await this.listGlobalMemories();
    if (memories.length === 0) return "";

    const grouped: Record<string, Memory[]> = {};
    const sensitiveKeys: Record<string, string[]> = {};
    for (const mem of memories) {
      if (role !== "admin" && isSensitiveCategory(mem.category)) {
        // For non-admin: remember the key exists but don't include the value
        if (!sensitiveKeys[mem.category]) sensitiveKeys[mem.category] = [];
        sensitiveKeys[mem.category].push(mem.key);
        continue;
      }
      if (!grouped[mem.category]) grouped[mem.category] = [];
      grouped[mem.category].push(mem);
    }

    const hasSensitive = Object.keys(sensitiveKeys).length > 0;
    if (Object.keys(grouped).length === 0 && !hasSensitive) return "";

    let context = `\n--- MEMORIAS DO ${config.agentName.toUpperCase()} ---\n`;
    for (const [category, mems] of Object.entries(grouped)) {
      context += `\n[${category.toUpperCase()}]\n`;
      for (const mem of mems) {
        context += `- ${mem.key}: ${mem.value}\n`;
      }
    }
    // For non-admin users: show that sensitive keys exist without revealing values
    if (hasSensitive) {
      for (const [category, keys] of Object.entries(sensitiveKeys)) {
        context += `\n[${category.toUpperCase()}]\n`;
        for (const key of keys) {
          context += `- ${key}: [configurado]\n`;
        }
      }
    }
    context += "--- FIM DAS MEMORIAS ---\n";

    return context;
  }

  /**
   * Build relevance-filtered memory context for the LLM system prompt.
   *
   * Instead of dumping ALL memories into every prompt, this method:
   * 1. Always includes sensitive categories (credenciais, senhas) for admin users
   *    (these are needed for sub-agent delegation).
   * 2. Embeds the user's query and scores each non-sensitive memory by cosine similarity.
   * 3. Injects only the top-K most relevant memories (default 15).
   * 4. Falls back to the full dump (buildGlobalMemoryContext) if embedding fails.
   *
   * @param role - User role for RBAC filtering
   * @param userQuery - The current user message for relevance scoring
   * @param topK - Maximum number of non-sensitive memories to include (default 15)
   */
  async buildRelevantMemoryContext(
    role: UserRole,
    userQuery: string,
    topK: number = 15
  ): Promise<string> {
    const memories = await this.listGlobalMemories();
    if (memories.length === 0) return "";

    // Separate memories into: always-include (sensitive) and candidates (non-sensitive)
    const alwaysInclude: Memory[] = [];
    const sensitiveKeys: Record<string, string[]> = {};
    const candidates: Memory[] = [];

    for (const mem of memories) {
      if (isSensitiveCategory(mem.category)) {
        if (role === "admin") {
          alwaysInclude.push(mem);
        } else {
          // Non-admin: show key exists but not value
          if (!sensitiveKeys[mem.category]) sensitiveKeys[mem.category] = [];
          sensitiveKeys[mem.category].push(mem.key);
        }
      } else {
        candidates.push(mem);
      }
    }

    // If few enough non-sensitive memories, include all (no point in filtering)
    if (candidates.length <= topK) {
      // All fit — use old behavior for simplicity
      return this.formatMemoryContext(alwaysInclude, candidates, sensitiveKeys);
    }

    // Score candidates by relevance to the user query
    let scoredCandidates: Array<{ mem: Memory; score: number }>;
    try {
      const embedding = new EmbeddingService();
      const queryVector = await embedding.embed(userQuery);

      // Embed each candidate's key+value text and compute cosine similarity
      const candidateTexts = candidates.map((m) => `${m.category} ${m.key}: ${m.value}`);
      const candidateVectors = await embedding.embedBatch(candidateTexts);

      scoredCandidates = candidates.map((mem, i) => ({
        mem,
        // Combine semantic similarity with importance as a tiebreaker.
        // Importance (1-10) is normalized to 0-0.1 range to act as tiebreaker,
        // not override semantic relevance.
        score: this.cosineSimilarity(queryVector, candidateVectors[i])
          + (mem.importance || 5) * 0.01,
      }));

      // Sort by combined score descending, take top K
      scoredCandidates.sort((a, b) => b.score - a.score);
      scoredCandidates = scoredCandidates.slice(0, topK);

      logger.info(
        {
          totalMemories: memories.length,
          candidates: candidates.length,
          selected: scoredCandidates.length,
          topScore: scoredCandidates[0]?.score.toFixed(3),
          bottomScore: scoredCandidates[scoredCandidates.length - 1]?.score.toFixed(3),
        },
        "Relevance-filtered memory context"
      );
    } catch (err) {
      // Embedding failed — fall back to full dump
      logger.warn({ err }, "Memory relevance scoring failed, falling back to full context");
      return this.buildGlobalMemoryContext(role);
    }

    const selected = scoredCandidates.map((s) => s.mem);
    return this.formatMemoryContext(alwaysInclude, selected, sensitiveKeys);
  }

  /**
   * Format memory context string from pre-selected memories.
   */
  private formatMemoryContext(
    alwaysInclude: Memory[],
    selected: Memory[],
    sensitiveKeys: Record<string, string[]>
  ): string {
    const grouped: Record<string, Memory[]> = {};
    for (const mem of [...alwaysInclude, ...selected]) {
      if (!grouped[mem.category]) grouped[mem.category] = [];
      grouped[mem.category].push(mem);
    }

    const hasSensitive = Object.keys(sensitiveKeys).length > 0;
    if (Object.keys(grouped).length === 0 && !hasSensitive) return "";

    let context = `\n--- MEMORIAS DO ${config.agentName.toUpperCase()} ---\n`;
    for (const [category, mems] of Object.entries(grouped)) {
      context += `\n[${category.toUpperCase()}]\n`;
      for (const mem of mems) {
        context += `- ${mem.key}: ${mem.value}\n`;
      }
    }
    if (hasSensitive) {
      for (const [category, keys] of Object.entries(sensitiveKeys)) {
        context += `\n[${category.toUpperCase()}]\n`;
        for (const key of keys) {
          context += `- ${key}: [configurado]\n`;
        }
      }
    }
    context += "--- FIM DAS MEMORIAS ---\n";

    return context;
  }

  /**
   * Compute cosine similarity between two vectors.
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  // ==================== USER PROFILE ====================

  /**
   * Update a user's profile JSONB field by merging new data.
   * Only overwrites individual keys, preserving existing data.
   */
  async updateUserProfile(
    userId: number,
    profileData: Record<string, string | null>
  ): Promise<void> {
    // Filter out null/empty values
    const filtered: Record<string, string> = {};
    for (const [k, v] of Object.entries(profileData)) {
      if (v && v.trim()) filtered[k] = v.trim();
    }
    if (Object.keys(filtered).length === 0) return;

    if (isPostgres()) {
      await query(
        `UPDATE users SET profile = COALESCE(profile, '{}')::jsonb || $1::jsonb, updated_at = NOW() WHERE id = $2`,
        [JSON.stringify(filtered), userId]
      );
    } else {
      // SQLite: read-modify-write
      const result = await query(`SELECT profile FROM users WHERE id = $1`, [userId]);
      if (result.rows.length === 0) return;
      let existing: Record<string, any> = {};
      try { existing = JSON.parse(result.rows[0].profile || "{}"); } catch { /* empty */ }
      const merged = { ...existing, ...filtered };
      await query(
        `UPDATE users SET profile = $1, updated_at = datetime('now') WHERE id = $2`,
        [JSON.stringify(merged), userId]
      );
    }

    logger.info({ userId, keys: Object.keys(filtered) }, "User profile updated");
  }

  /**
   * Get a user's profile data.
   */
  async getUserProfile(userId: number): Promise<Record<string, any>> {
    const result = await query(`SELECT profile FROM users WHERE id = $1`, [userId]);
    if (result.rows.length === 0) return {};
    try {
      return JSON.parse(result.rows[0].profile || "{}");
    } catch {
      return {};
    }
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

  /**
   * Save a message using user_id.
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
    fileInfos?: FileInfo[],
    connectorName?: string
  ): Promise<void> {
    const imageUrlValue = imageUrls && imageUrls.length > 0 ? JSON.stringify(imageUrls) : null;
    const fileInfosValue = fileInfos && fileInfos.length > 0 ? JSON.stringify(fileInfos) : null;
    await query(
      `INSERT INTO conversations (user_id, role, content, model_used, tokens_used, audio_url, image_url, message_type, file_infos, connector_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [userId, role, content, modelUsed || null, tokensUsed || null, audioUrl || null, imageUrlValue, messageType || "text", fileInfosValue, connectorName || null]
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
   * Update the content of the most recent user message that has a given audio_url.
   * Used to persist audio transcription back to the DB after Gemini transcribes it.
   */
  async updateAudioTranscription(userId: number, audioUrl: string, transcription: string): Promise<void> {
    await query(
      `UPDATE conversations SET content = $1 WHERE id = (
         SELECT id FROM conversations WHERE user_id = $2 AND audio_url = $3 AND role = 'user'
         ORDER BY created_at DESC LIMIT 1
       )`,
      [transcription, userId, audioUrl]
    );
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
      `SELECT role, content, created_at, audio_url, image_url, message_type, file_infos, connector_name FROM conversations
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, maxMessages]
    );
    return result.rows.reverse().map((row: any) => {
      const msg: ConversationMessage = { role: row.role, content: row.content };
      if (row.created_at) msg.created_at = row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at;
      if (row.connector_name) msg.connector_name = row.connector_name;
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

  /**
   * Get or create a user by phone number (legacy connector path).
   * Returns the user's numeric ID and display name.
   */
  async getOrCreateUser(
    phone: string,
    displayName?: string
  ): Promise<{
    id: number;
    phone: string;
    displayName: string | null;
  }> {
    // Try to get existing user
    let result = await query(`SELECT id, phone, display_name FROM users WHERE phone = $1`, [
      phone,
    ]);

    if (result.rows.length > 0) {
      // Update display_name if provided and different
      if (displayName && displayName !== result.rows[0].display_name) {
        await query(
          `UPDATE users SET display_name = $1, updated_at = NOW() WHERE phone = $2`,
          [displayName, phone]
        );
        result.rows[0].display_name = displayName;
      }
      return { id: result.rows[0].id, phone: result.rows[0].phone, displayName: result.rows[0].display_name };
    }

    // Create new user — always as pending with no role.
    // Admin is a unique Web UI-only user created by bootstrap; phone users never auto-promote.
    result = await query(
      `INSERT INTO users (phone, display_name) VALUES ($1, $2) RETURNING id, phone, display_name`,
      [phone, displayName || null]
    );
    logger.info({ phone }, "New user created (pending)");
    return { id: result.rows[0].id, phone: result.rows[0].phone, displayName: result.rows[0].display_name };
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
