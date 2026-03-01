import { vectorQuery } from "./vector-db.js";
import { EmbeddingService } from "./embedding-service.js";
import { logger } from "../config/logger.js";

export interface VectorMemory {
  id: number;
  user_phone: string;
  content: string;
  category: string;
  source: string;
  metadata: Record<string, any>;
  hit_count: number;
  last_hit_at: Date | null;
  similarity?: number;
  created_by?: number | null;
  creator_role?: string | null;
  created_at: Date;
}

/**
 * Vector memory service for semantic search using pgvector.
 *
 * Architecture:
 * - Structured data (passwords, credentials, exact key-value) stays in PostgreSQL
 * - Semantic/conversational data (facts, preferences, knowledge) goes in pgvector
 * - Agent queries both and merges results for full context
 */
export class VectorMemoryService {
  private embedding: EmbeddingService;

  constructor(embedding: EmbeddingService) {
    this.embedding = embedding;
  }

  /**
   * Store a memory with its embedding vector.
   */
  async store(
    userPhone: string,
    content: string,
    category: string = "conversation",
    source: string = "auto",
    metadata: Record<string, any> = {}
  ): Promise<VectorMemory> {
    const vector = await this.embedding.embed(content);
    const pgVector = EmbeddingService.toPgVector(vector);

    // Check for near-duplicate (cosine similarity > 0.95)
    const duplicate = await vectorQuery(
      `SELECT id, content, 1 - (embedding <=> $3::vector) as similarity
       FROM memory_embeddings
       WHERE user_phone = $1 AND category = $2
         AND 1 - (embedding <=> $3::vector) > 0.95
       LIMIT 1`,
      [userPhone, category, pgVector]
    );

    if (duplicate.rows.length > 0) {
      // Update existing instead of creating duplicate
      const existing = duplicate.rows[0];
      logger.info(
        { id: existing.id, similarity: existing.similarity },
        "Updating near-duplicate memory"
      );
      const result = await vectorQuery(
        `UPDATE memory_embeddings
         SET content = $1, embedding = $2::vector, metadata = $3, updated_at = NOW()
         WHERE id = $4
         RETURNING *`,
        [content, pgVector, JSON.stringify(metadata), existing.id]
      );
      return result.rows[0];
    }

    const result = await vectorQuery(
      `INSERT INTO memory_embeddings (user_phone, content, category, source, embedding, metadata)
       VALUES ($1, $2, $3, $4, $5::vector, $6)
       RETURNING id, user_phone, content, category, source, metadata, created_at`,
      [userPhone, content, category, source, pgVector, JSON.stringify(metadata)]
    );

    logger.info({ userPhone, category, id: result.rows[0].id }, "Vector memory stored");
    return result.rows[0];
  }

  /**
   * Semantic search: find memories similar to the query text.
   * Uses cosine distance for similarity ranking.
   * Increments hit_count on all returned results.
   */
  async search(
    userPhone: string,
    queryText: string,
    limit: number = 5,
    minSimilarity: number = 0.3
  ): Promise<VectorMemory[]> {
    const vector = await this.embedding.embed(queryText);
    const pgVector = EmbeddingService.toPgVector(vector);

    const result = await vectorQuery(
      `SELECT id, user_phone, content, category, source, metadata, hit_count, last_hit_at, created_at,
              1 - (embedding <=> $2::vector) as similarity
       FROM memory_embeddings
       WHERE user_phone = $1
         AND 1 - (embedding <=> $2::vector) > $3
       ORDER BY embedding <=> $2::vector
       LIMIT $4`,
      [userPhone, pgVector, minSimilarity, limit]
    );

    // Increment hit_count for all returned results (fire-and-forget)
    if (result.rows.length > 0) {
      const ids = result.rows.map((r: VectorMemory) => r.id);
      vectorQuery(
        `UPDATE memory_embeddings
         SET hit_count = hit_count + 1, last_hit_at = NOW()
         WHERE id = ANY($1)`,
        [ids]
      ).catch((err) => logger.warn({ err }, "Failed to increment hit_count"));
    }

    return result.rows;
  }

  /**
   * Search within a specific category.
   * Increments hit_count on all returned results.
   */
  async searchByCategory(
    userPhone: string,
    queryText: string,
    category: string,
    limit: number = 5
  ): Promise<VectorMemory[]> {
    const vector = await this.embedding.embed(queryText);
    const pgVector = EmbeddingService.toPgVector(vector);

    const result = await vectorQuery(
      `SELECT id, user_phone, content, category, source, metadata, hit_count, last_hit_at, created_at,
              1 - (embedding <=> $2::vector) as similarity
       FROM memory_embeddings
       WHERE user_phone = $1 AND category = $3
       ORDER BY embedding <=> $2::vector
       LIMIT $4`,
      [userPhone, pgVector, category, limit]
    );

    if (result.rows.length > 0) {
      const ids = result.rows.map((r: VectorMemory) => r.id);
      vectorQuery(
        `UPDATE memory_embeddings
         SET hit_count = hit_count + 1, last_hit_at = NOW()
         WHERE id = ANY($1)`,
        [ids]
      ).catch((err) => logger.warn({ err }, "Failed to increment hit_count"));
    }

    return result.rows;
  }

  /**
   * Delete a specific vector memory by ID.
   */
  async delete(id: number): Promise<boolean> {
    const result = await vectorQuery(
      `DELETE FROM memory_embeddings WHERE id = $1`,
      [id]
    );
    return (result.rowCount || 0) > 0;
  }

  /**
   * Delete all vector memories for a user.
   */
  async deleteAll(userPhone: string): Promise<number> {
    const result = await vectorQuery(
      `DELETE FROM memory_embeddings WHERE user_phone = $1`,
      [userPhone]
    );
    return result.rowCount || 0;
  }

  /**
   * Delete vector memories by category.
   */
  async deleteByCategory(userPhone: string, category: string): Promise<number> {
    const result = await vectorQuery(
      `DELETE FROM memory_embeddings WHERE user_phone = $1 AND category = $2`,
      [userPhone, category]
    );
    return result.rowCount || 0;
  }

  /**
   * Count memories for a user.
   */
  async count(userPhone: string): Promise<number> {
    const result = await vectorQuery(
      `SELECT COUNT(*) as count FROM memory_embeddings WHERE user_phone = $1`,
      [userPhone]
    );
    return parseInt(result.rows[0].count);
  }

  /**
   * Evict the least-accessed memories to free space.
   * Deletes memories with the lowest hit_count first, oldest first on tie.
   * Returns the number of deleted rows.
   */
  async evictLeastUsed(count: number): Promise<number> {
    const result = await vectorQuery(
      `DELETE FROM memory_embeddings
       WHERE id IN (
         SELECT id FROM memory_embeddings
         ORDER BY hit_count ASC, created_at ASC
         LIMIT $1
       )`,
      [count]
    );
    const deleted = result.rowCount || 0;
    if (deleted > 0) {
      logger.info({ deleted }, "Evicted least-used vector memories");
    }
    return deleted;
  }

  /**
   * Get total count of all memories (across all users).
   */
  async countAll(): Promise<number> {
    const result = await vectorQuery(
      `SELECT COUNT(*) as count FROM memory_embeddings`
    );
    return parseInt(result.rows[0].count);
  }

  /**
   * Get the database size in bytes via PostgreSQL.
   */
  async getDatabaseSizeBytes(): Promise<number> {
    const result = await vectorQuery(
      `SELECT pg_database_size(current_database()) as size_bytes`
    );
    return parseInt(result.rows[0].size_bytes);
  }

  /**
   * List recent vector memories (without embedding, for display).
   */
  async listRecent(
    userPhone: string,
    limit: number = 20
  ): Promise<VectorMemory[]> {
    const result = await vectorQuery(
      `SELECT id, user_phone, content, category, source, metadata, created_at
       FROM memory_embeddings
       WHERE user_phone = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userPhone, limit]
    );
    return result.rows;
  }

  // ==================== RBAC-AWARE GLOBAL METHODS ====================

  /**
   * Store a memory with created_by tracking (global — no user_phone filter).
   */
  async storeGlobal(
    content: string,
    category: string = "conversation",
    source: string = "auto",
    metadata: Record<string, any> = {},
    createdBy?: number
  ): Promise<VectorMemory> {
    const vector = await this.embedding.embed(content);
    const pgVector = EmbeddingService.toPgVector(vector);

    // Check for near-duplicate globally (cosine similarity > 0.95)
    const duplicate = await vectorQuery(
      `SELECT id, content, 1 - (embedding <=> $2::vector) as similarity
       FROM memory_embeddings
       WHERE category = $1
         AND 1 - (embedding <=> $2::vector) > 0.95
       LIMIT 1`,
      [category, pgVector]
    );

    if (duplicate.rows.length > 0) {
      const existing = duplicate.rows[0];
      logger.info(
        { id: existing.id, similarity: existing.similarity },
        "Updating near-duplicate global memory"
      );
      const result = await vectorQuery(
        `UPDATE memory_embeddings
         SET content = $1, embedding = $2::vector, metadata = $3, created_by = $4, updated_at = NOW()
         WHERE id = $5
         RETURNING *`,
        [content, pgVector, JSON.stringify(metadata), createdBy || null, existing.id]
      );
      return result.rows[0];
    }

    const result = await vectorQuery(
      `INSERT INTO memory_embeddings (user_phone, content, category, source, embedding, metadata, created_by)
       VALUES ('', $1, $2, $3, $4::vector, $5, $6)
       RETURNING id, user_phone, content, category, source, metadata, created_by, created_at`,
      [content, category, source, pgVector, JSON.stringify(metadata), createdBy || null]
    );

    logger.info({ category, createdBy, id: result.rows[0].id }, "Global vector memory stored");
    return result.rows[0];
  }

  /**
   * Semantic search across all global memories (no user_phone filter).
   * Returns creator role info for LLM context building.
   */
  async searchGlobal(
    queryText: string,
    limit: number = 5,
    minSimilarity: number = 0.3
  ): Promise<VectorMemory[]> {
    const vector = await this.embedding.embed(queryText);
    const pgVector = EmbeddingService.toPgVector(vector);

    const result = await vectorQuery(
      `SELECT me.id, me.content, me.category, me.source, me.metadata,
              me.hit_count, me.last_hit_at, me.created_by, me.created_at,
              1 - (me.embedding <=> $1::vector) as similarity,
              u.role as creator_role
       FROM memory_embeddings me
       LEFT JOIN users u ON u.id = me.created_by
       WHERE 1 - (me.embedding <=> $1::vector) > $2
       ORDER BY me.embedding <=> $1::vector
       LIMIT $3`,
      [pgVector, minSimilarity, limit]
    );

    // Increment hit_count for all returned results (fire-and-forget)
    if (result.rows.length > 0) {
      const ids = result.rows.map((r: VectorMemory) => r.id);
      vectorQuery(
        `UPDATE memory_embeddings
         SET hit_count = hit_count + 1, last_hit_at = NOW()
         WHERE id = ANY($1)`,
        [ids]
      ).catch((err) => logger.warn({ err }, "Failed to increment hit_count"));
    }

    return result.rows;
  }
}
