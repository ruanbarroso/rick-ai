/**
 * User resolution and management service for RBAC.
 *
 * Handles:
 *   - Resolving connector messages to users (via connector_identities)
 *   - Creating new users (pending status) when unknown identities appear
 *   - Listing/filtering users for admin management
 *   - Role assignment, blocking/unblocking
 *   - Profile management (JSONB merge)
 *   - Activity tracking
 */

import { query, isPostgres } from "../memory/database.js";
import { config } from "../config/env.js";
import { logger } from "../config/logger.js";
import { UserRole, UserStatus } from "./permissions.js";

// ==================== Types ====================

export interface User {
  id: number;
  role: UserRole;
  status: UserStatus;
  displayName: string | null;
  profile: Record<string, any>;
  lastActivityAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConnectorIdentity {
  id: number;
  userId: number;
  connector: string;
  externalId: string;
  displayName: string | null;
  createdAt: Date;
}

export interface UserWithIdentities extends User {
  identities: ConnectorIdentity[];
}

export interface UserListFilter {
  role?: UserRole;
  status?: UserStatus;
}

// ==================== Welcome Templates ====================

function getWelcomeTemplates(): Record<string, string> {
  const name = config.agentName;
  return {
    dev: `Ola! Agora voce tem acesso ao ${name}. Pode me perguntar sobre a stack, me ensinar coisas novas, ou pedir para eu executar tarefas.`,
    business: `Ola! Agora voce tem acesso ao ${name}. Pode me fazer perguntas e estou aqui para ajudar.`,
  };
}

// ==================== Service ====================

export class UserService {
  /**
   * Callback for sending welcome messages via connectors.
   * Set by the connector manager after initialization to avoid circular deps.
   */
  private welcomeSender:
    | ((connector: string, externalId: string, text: string) => Promise<void>)
    | null = null;

  /**
   * Register the welcome message sender (called by ConnectorManager).
   */
  setWelcomeSender(
    fn: (connector: string, externalId: string, text: string) => Promise<void>
  ): void {
    this.welcomeSender = fn;
  }

  // ==================== User Resolution ====================

  /**
   * Resolve a connector identity to a user.
   * If the identity doesn't exist, creates a new pending user.
   *
   * This is the main entry point for the connector layer.
   */
  async resolveUser(
    connector: string,
    externalId: string,
    displayName?: string
  ): Promise<User> {
    // Try to find existing identity
    const existing = await query(
      `SELECT ci.user_id, ci.display_name as ci_display_name,
              u.id, u.role, u.status, u.display_name, u.profile,
              u.last_activity_at, u.created_at, u.updated_at
       FROM connector_identities ci
       JOIN users u ON u.id = ci.user_id
       WHERE ci.connector = $1 AND ci.external_id = $2`,
      [connector, externalId]
    );

    if (existing.rows.length > 0) {
      const row = existing.rows[0];

      // Update push name if changed
      if (displayName && displayName !== row.ci_display_name) {
        await query(
          `UPDATE connector_identities SET display_name = $1
           WHERE connector = $2 AND external_id = $3`,
          [displayName, connector, externalId]
        );
      }

      return this.rowToUser(row);
    }

    // New identity — create user + identity
    return this.createPendingUser(connector, externalId, displayName);
  }

  /**
   * Create a new pending user with a connector identity.
   */
  private async createPendingUser(
    connector: string,
    externalId: string,
    displayName?: string
  ): Promise<User> {
    // Create the user record.
    // phone column: nullable on PostgreSQL (migration 009 drops NOT NULL),
    // but still NOT NULL on SQLite (can't alter column constraints).
    // For SQLite, generate a placeholder phone from the connector identity.
    let userResult;
    if (isPostgres()) {
      userResult = await query(
        `INSERT INTO users (role, status, display_name, profile, created_at, updated_at)
         VALUES (NULL, 'pending', $1, '{}', NOW(), NOW())
         RETURNING *`,
        [displayName || null]
      );
    } else {
      // SQLite: phone is still NOT NULL, use connector:externalId as placeholder
      const placeholderPhone = `${connector}:${externalId}`;
      userResult = await query(
        `INSERT INTO users (phone, role, status, display_name, profile, created_at, updated_at)
         VALUES ($1, NULL, 'pending', $2, '{}', NOW(), NOW())
         RETURNING *`,
        [placeholderPhone, displayName || null]
      );
    }
    const user = this.rowToUser(userResult.rows[0]);

    // Create the connector identity
    await query(
      `INSERT INTO connector_identities (user_id, connector, external_id, display_name)
       VALUES ($1, $2, $3, $4)`,
      [user.id, connector, externalId, displayName || null]
    );

    logger.info(
      { userId: user.id, connector, externalId, displayName },
      "New pending user created"
    );

    return user;
  }

  // ==================== User Queries ====================

  /**
   * Get a user by ID.
   */
  async getUserById(id: number): Promise<User | null> {
    const result = await query(`SELECT * FROM users WHERE id = $1`, [id]);
    if (result.rows.length === 0) return null;
    return this.rowToUser(result.rows[0]);
  }

  /**
   * Get the admin user.
   */
  async getAdminUser(): Promise<User | null> {
    const result = await query(
      `SELECT * FROM users WHERE role = 'admin' LIMIT 1`
    );
    if (result.rows.length === 0) return null;
    return this.rowToUser(result.rows[0]);
  }

  /**
   * Get a user with all their connector identities.
   */
  async getUserWithIdentities(id: number): Promise<UserWithIdentities | null> {
    const user = await this.getUserById(id);
    if (!user) return null;

    const identities = await this.getIdentities(id);
    return { ...user, identities };
  }

  /**
   * Get all connector identities for a user.
   */
  async getIdentities(userId: number): Promise<ConnectorIdentity[]> {
    const result = await query(
      `SELECT * FROM connector_identities WHERE user_id = $1 ORDER BY created_at`,
      [userId]
    );
    return result.rows.map(this.rowToIdentity);
  }

  /**
   * Get a specific connector identity for a user.
   */
  async getIdentity(
    userId: number,
    connector: string
  ): Promise<ConnectorIdentity | null> {
    const result = await query(
      `SELECT * FROM connector_identities
       WHERE user_id = $1 AND connector = $2`,
      [userId, connector]
    );
    if (result.rows.length === 0) return null;
    return this.rowToIdentity(result.rows[0]);
  }

  /**
   * List users with optional filtering.
   * Ordered: pending first, then active by last_activity_at DESC, then blocked.
   */
  async listUsers(filter?: UserListFilter): Promise<User[]> {
    let sql = `SELECT * FROM users WHERE role != 'admin' OR role IS NULL`;
    const params: any[] = [];
    let paramIdx = 1;

    if (filter?.role !== undefined) {
      if (filter.role === null) {
        sql += ` AND role IS NULL`;
      } else {
        sql += ` AND role = $${paramIdx++}`;
        params.push(filter.role);
      }
    }

    if (filter?.status) {
      sql += ` AND status = $${paramIdx++}`;
      params.push(filter.status);
    }

    // Order: pending first, then active (most recent activity), then blocked
    sql += ` ORDER BY
      CASE status
        WHEN 'pending' THEN 0
        WHEN 'active' THEN 1
        WHEN 'blocked' THEN 2
        ELSE 3
      END,
      CASE WHEN status = 'pending' THEN created_at END DESC,
      CASE WHEN status = 'active' THEN last_activity_at END DESC NULLS LAST,
      created_at DESC`;

    const result = await query(sql, params);
    return result.rows.map((r: any) => this.rowToUser(r));
  }

  /**
   * Count pending users (for badge).
   */
  async getPendingCount(): Promise<number> {
    const result = await query(
      `SELECT COUNT(*) as count FROM users
       WHERE status = 'pending' AND (role IS NULL)`
    );
    return parseInt(result.rows[0]?.count || "0", 10);
  }

  // ==================== User Management ====================

  /**
   * Set a user's role. Automatically sets status to 'active'.
   * Cannot change the admin's role.
   * Sends a welcome message on first activation (pending -> active).
   */
  async setUserRole(userId: number, role: "dev" | "business"): Promise<{ user: User; welcomeSent: boolean; welcomeError?: string }> {
    // Safety: prevent changing admin role
    const existing = await this.getUserById(userId);
    if (!existing) throw new Error(`User ${userId} not found`);
    if (existing.role === "admin") throw new Error("Cannot change admin role");

    const wasPending = existing.status === "pending";

    await query(
      `UPDATE users SET role = $1, status = 'active', updated_at = NOW()
       WHERE id = $2`,
      [role, userId]
    );

    const updated = (await this.getUserById(userId))!;

    // Send welcome message on first activation
    let welcomeSent = false;
    let welcomeError: string | undefined;

    if (wasPending && this.welcomeSender) {
      const identities = await this.getIdentities(userId);
      const template = getWelcomeTemplates()[role];
      logger.info(
        { userId, role, identityCount: identities.length, hasTemplate: !!template },
        "Sending welcome message to newly activated user"
      );
      if (template && identities.length > 0) {
        for (const identity of identities) {
          try {
            await this.welcomeSender(
              identity.connector,
              identity.externalId,
              template
            );
            welcomeSent = true;
          } catch (err) {
            welcomeError = (err as Error).message || "Erro desconhecido";
            logger.warn(
              { userId, connector: identity.connector, err },
              "Failed to send welcome message"
            );
          }
        }
      } else if (!template) {
        welcomeError = `Template não encontrado para role "${role}"`;
      } else {
        welcomeError = "Usuário sem identities de connector";
      }
    } else if (!wasPending) {
      logger.debug({ userId, role, status: existing.status }, "Skipping welcome — user was not pending");
    } else if (!this.welcomeSender) {
      welcomeError = "Welcome sender não configurado";
      logger.warn({ userId }, "Welcome sender not registered");
    }

    logger.info(
      { userId, role, wasPending, welcomeSent },
      "User role updated"
    );

    return { user: updated, welcomeSent, welcomeError };
  }

  /**
   * Block a user. Preserves their role for potential unblocking.
   * Cannot block the admin.
   */
  async blockUser(userId: number): Promise<User> {
    const existing = await this.getUserById(userId);
    if (!existing) throw new Error(`User ${userId} not found`);
    if (existing.role === "admin") throw new Error("Cannot block admin");

    await query(
      `UPDATE users SET status = 'blocked', updated_at = NOW() WHERE id = $1`,
      [userId]
    );

    logger.info({ userId }, "User blocked");
    return (await this.getUserById(userId))!;
  }

  /**
   * Unblock a user. Restores to active if they have a role, otherwise pending.
   */
  async unblockUser(userId: number): Promise<User> {
    const existing = await this.getUserById(userId);
    if (!existing) throw new Error(`User ${userId} not found`);

    const newStatus = existing.role ? "active" : "pending";

    await query(
      `UPDATE users SET status = $1, updated_at = NOW() WHERE id = $2`,
      [newStatus, userId]
    );

    logger.info({ userId, newStatus }, "User unblocked");
    return (await this.getUserById(userId))!;
  }

  // ==================== Profile ====================

  /**
   * Update a user's profile (JSONB merge).
   * Merges provided fields into existing profile.
   */
  async updateProfile(
    userId: number,
    profile: Record<string, any>
  ): Promise<User> {
    // Merge: read current, overlay new fields
    const existing = await this.getUserById(userId);
    if (!existing) throw new Error(`User ${userId} not found`);

    const merged = { ...existing.profile, ...profile };

    await query(
      `UPDATE users SET profile = $1, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(merged), userId]
    );

    return (await this.getUserById(userId))!;
  }

  /**
   * Update display name.
   */
  async updateDisplayName(userId: number, displayName: string): Promise<void> {
    await query(
      `UPDATE users SET display_name = $1, updated_at = NOW() WHERE id = $2`,
      [displayName, userId]
    );
  }

  // ==================== Activity Tracking ====================

  /**
   * Update the last activity timestamp for a user.
   * Called by connectors on every incoming message.
   */
  async updateLastActivity(userId: number): Promise<void> {
    await query(
      `UPDATE users SET last_activity_at = NOW() WHERE id = $1`,
      [userId]
    );
  }

  // ==================== Row Mappers ====================

  private rowToUser(row: any): User {
    return {
      id: row.id,
      role: row.role || null,
      status: row.status || "pending",
      displayName: row.display_name || null,
      profile: typeof row.profile === "string"
        ? JSON.parse(row.profile || "{}")
        : row.profile || {},
      lastActivityAt: row.last_activity_at
        ? new Date(row.last_activity_at)
        : null,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  private rowToIdentity(row: any): ConnectorIdentity {
    return {
      id: row.id,
      userId: row.user_id,
      connector: row.connector,
      externalId: row.external_id,
      displayName: row.display_name || null,
      createdAt: new Date(row.created_at),
    };
  }
}
