/**
 * Webhook management service.
 *
 * Each webhook has a dedicated internal user for context isolation.
 * Webhooks are triggered via POST /api/webhook/:id with a Bearer secret.
 * The payload is rendered via a template and delegated to a sub-agent.
 */

import { randomBytes } from "node:crypto";
import { query } from "../memory/database.js";
import { logger } from "../config/logger.js";
import { UserRole } from "../auth/permissions.js";

// ==================== Types ====================

export interface Webhook {
  id: string;
  name: string;
  userId: number;       // internal user for execution
  secret: string;
  template: string;
  executionMode: string;
  active: boolean;
  lastTriggeredAt: string | null;
  triggerCount: number;
  createdBy: number;
  updatedBy: number;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookCreateInput {
  name: string;
  template?: string;
  executionMode?: string;
}

export interface WebhookUpdateInput {
  name?: string;
  template?: string;
  executionMode?: string;
  active?: boolean;
}

// ==================== Helpers ====================

function generateId(): string {
  return randomBytes(16).toString("hex");
}

function generateSecret(): string {
  return randomBytes(32).toString("hex");
}

function rowToWebhook(row: any): Webhook {
  return {
    id: row.id,
    name: row.name,
    userId: row.user_id,
    secret: row.secret,
    template: row.template || "",
    executionMode: row.execution_mode || "build",
    active: row.active === true || row.active === 1,
    lastTriggeredAt: row.last_triggered_at || null,
    triggerCount: row.trigger_count || 0,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Render a template with payload fields.
 * Replaces {{fieldName}} with values from the payload.
 * Supports nested fields via dot notation: {{alert.title}}
 */
export function renderTemplate(template: string, payload: Record<string, any>): string {
  if (!template.trim()) {
    return JSON.stringify(payload, null, 2);
  }
  return template.replace(/\{\{([^}]+)\}\}/g, (_, path: string) => {
    const keys = path.trim().split(".");
    let val: any = payload;
    for (const k of keys) {
      if (val == null) break;
      val = val[k];
    }
    if (val === undefined || val === null) return `{{${path.trim()}}}`;
    return typeof val === "object" ? JSON.stringify(val) : String(val);
  });
}

// ==================== Service ====================

export class WebhookService {
  /**
   * Create a new webhook with a dedicated internal user.
   */
  async create(input: WebhookCreateInput, actorId: number): Promise<Webhook> {
    const id = generateId();
    const secret = generateSecret();

    // Create dedicated internal user
    const userResult = await query(
      `INSERT INTO users (phone, display_name, role, status, created_at, updated_at)
       VALUES ($1, $2, 'internal', 'active', NOW(), NOW()) RETURNING id`,
      [`webhook:${id}`, `Webhook: ${input.name}`]
    );
    const internalUserId = userResult.rows[0].id;

    // Create connector identity for the internal user
    await query(
      `INSERT INTO connector_identities (user_id, connector, external_id, display_name, created_at)
       VALUES ($1, 'webhook', $2, $3, NOW())`,
      [internalUserId, id, input.name]
    );

    // Create the webhook
    await query(
      `INSERT INTO webhooks (id, name, user_id, secret, template, execution_mode, active, trigger_count, created_by, updated_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE, 0, $7, $7, NOW(), NOW())`,
      [id, input.name, internalUserId, secret, input.template || "", input.executionMode || "build", actorId]
    );

    // Audit log
    await this.audit("webhook", id, "create", actorId, { name: input.name });

    logger.info({ webhookId: id, name: input.name, actorId }, "Webhook created");
    return this.getById(id) as Promise<Webhook>;
  }

  /**
   * Update an existing webhook.
   * Enforces RBAC: devs cannot modify webhooks created by admin.
   */
  async update(
    id: string,
    input: WebhookUpdateInput,
    actorId: number,
    actorRole: UserRole
  ): Promise<Webhook | null> {
    const existing = await this.getById(id);
    if (!existing) return null;

    // RBAC: check if actor can modify this webhook
    if (!await this.canModify(existing, actorId, actorRole)) {
      throw new Error("Permissao negada: apenas o admin pode modificar webhooks criados por admin.");
    }

    const sets: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;
    const changes: Record<string, any> = {};

    if (input.name !== undefined && input.name !== existing.name) {
      sets.push(`name = $${paramIdx++}`);
      params.push(input.name);
      changes.name = { from: existing.name, to: input.name };
      // Also update the internal user's display_name
      await query(`UPDATE users SET display_name = $1, updated_at = NOW() WHERE id = $2`, [`Webhook: ${input.name}`, existing.userId]);
    }
    if (input.template !== undefined && input.template !== existing.template) {
      sets.push(`template = $${paramIdx++}`);
      params.push(input.template);
      changes.template = { from: existing.template?.substring(0, 50), to: input.template.substring(0, 50) };
    }
    if (input.executionMode !== undefined && input.executionMode !== existing.executionMode) {
      sets.push(`execution_mode = $${paramIdx++}`);
      params.push(input.executionMode);
      changes.executionMode = { from: existing.executionMode, to: input.executionMode };
    }
    if (input.active !== undefined && input.active !== existing.active) {
      sets.push(`active = $${paramIdx++}`);
      params.push(input.active);
      changes.active = { from: existing.active, to: input.active };
    }

    if (sets.length === 0) return existing;

    sets.push(`updated_by = $${paramIdx++}`);
    params.push(actorId);
    sets.push(`updated_at = NOW()`);
    params.push(id);

    await query(`UPDATE webhooks SET ${sets.join(", ")} WHERE id = $${paramIdx}`, params);
    await this.audit("webhook", id, "update", actorId, changes);

    logger.info({ webhookId: id, actorId, changes }, "Webhook updated");
    return this.getById(id);
  }

  /**
   * Delete a webhook and its internal user.
   */
  async delete(id: string, actorId: number, actorRole: UserRole): Promise<boolean> {
    const existing = await this.getById(id);
    if (!existing) return false;

    if (!await this.canModify(existing, actorId, actorRole)) {
      throw new Error("Permissao negada: apenas o admin pode apagar webhooks criados por admin.");
    }

    await query(`DELETE FROM webhooks WHERE id = $1`, [id]);
    // Clean up internal user and identity
    await query(`DELETE FROM connector_identities WHERE connector = 'webhook' AND external_id = $1`, [id]);
    // Don't delete the user — keep for audit trail and any existing sessions

    await this.audit("webhook", id, "delete", actorId, { name: existing.name });
    logger.info({ webhookId: id, actorId }, "Webhook deleted");
    return true;
  }

  /**
   * Record a trigger event.
   */
  async recordTrigger(id: string): Promise<void> {
    await query(
      `UPDATE webhooks SET last_triggered_at = NOW(), trigger_count = trigger_count + 1 WHERE id = $1`,
      [id]
    );
  }

  /**
   * Get a webhook by ID.
   */
  async getById(id: string): Promise<Webhook | null> {
    const result = await query(`SELECT * FROM webhooks WHERE id = $1`, [id]);
    if (result.rows.length === 0) return null;
    return rowToWebhook(result.rows[0]);
  }

  /**
   * Get a webhook by secret (for trigger authentication).
   */
  async getBySecret(id: string, secret: string): Promise<Webhook | null> {
    const result = await query(
      `SELECT * FROM webhooks WHERE id = $1 AND secret = $2`,
      [id, secret]
    );
    if (result.rows.length === 0) return null;
    return rowToWebhook(result.rows[0]);
  }

  /**
   * List all webhooks.
   */
  async list(): Promise<Webhook[]> {
    const result = await query(`SELECT * FROM webhooks ORDER BY created_at DESC`);
    return result.rows.map(rowToWebhook);
  }

  /**
   * Get audit log for an entity.
   */
  async getAuditLog(entityType: string, entityId: string): Promise<any[]> {
    const result = await query(
      `SELECT al.*, u.display_name as actor_name
       FROM automation_audit_log al
       LEFT JOIN users u ON u.id = al.actor_id
       WHERE al.entity_type = $1 AND al.entity_id = $2
       ORDER BY al.created_at DESC LIMIT 50`,
      [entityType, entityId]
    );
    return result.rows;
  }

  // ==================== Private ====================

  /**
   * Check if an actor can modify a webhook.
   * Devs cannot modify webhooks created by admin.
   */
  private async canModify(webhook: Webhook, actorId: number, actorRole: UserRole): Promise<boolean> {
    if (actorRole === "admin") return true;
    // Dev can only modify if the creator is NOT admin
    const creatorResult = await query(`SELECT role FROM users WHERE id = $1`, [webhook.createdBy]);
    if (creatorResult.rows.length === 0) return true;
    return creatorResult.rows[0].role !== "admin";
  }

  private async audit(entityType: string, entityId: string, action: string, actorId: number, changes?: any): Promise<void> {
    await query(
      `INSERT INTO automation_audit_log (entity_type, entity_id, action, actor_id, changes, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [entityType, entityId, action, actorId, changes ? JSON.stringify(changes) : null]
    ).catch((err) => logger.warn({ err }, "Failed to write audit log"));
  }
}
