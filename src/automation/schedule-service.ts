/**
 * Schedule management and execution service.
 *
 * Each schedule has a dedicated internal user for context isolation.
 * Schedules use cron expressions and are checked every 60 seconds.
 * When a schedule fires, it delegates to a sub-agent using the internal user.
 */

import { randomBytes } from "node:crypto";
import { query } from "../memory/database.js";
import { logger } from "../config/logger.js";
import { UserRole } from "../auth/permissions.js";

// ==================== Types ====================

export interface Schedule {
  id: string;
  name: string;
  userId: number;       // internal user for execution
  cron: string;
  taskText: string;
  executionMode: string;
  active: boolean;
  maxConcurrent: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  runCount: number;
  createdBy: number;
  updatedBy: number;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleCreateInput {
  name: string;
  cron: string;
  taskText: string;
  executionMode?: string;
  maxConcurrent?: number;
}

export interface ScheduleUpdateInput {
  name?: string;
  cron?: string;
  taskText?: string;
  executionMode?: string;
  active?: boolean;
  maxConcurrent?: number;
}

// ==================== Cron Parser ====================

/**
 * Minimal cron expression parser supporting standard 5-field format:
 *   minute hour day-of-month month day-of-week
 *
 * Supports: asterisk, specific values, ranges (1-5), steps (star/5), and lists (1,3,5).
 */
function parseCronField(field: string, min: number, max: number): number[] {
  const values: Set<number> = new Set();

  for (const part of field.split(",")) {
    if (part === "*") {
      for (let i = min; i <= max; i++) values.add(i);
    } else if (part.includes("/")) {
      const [range, stepStr] = part.split("/");
      const step = parseInt(stepStr, 10);
      let start = min;
      let end = max;
      if (range !== "*") {
        if (range.includes("-")) {
          [start, end] = range.split("-").map(Number);
        } else {
          start = parseInt(range, 10);
        }
      }
      for (let i = start; i <= end; i += step) values.add(i);
    } else if (part.includes("-")) {
      const [startStr, endStr] = part.split("-");
      for (let i = parseInt(startStr, 10); i <= parseInt(endStr, 10); i++) values.add(i);
    } else {
      values.add(parseInt(part, 10));
    }
  }

  return Array.from(values).filter((v) => v >= min && v <= max).sort((a, b) => a - b);
}

/**
 * Compute the next run time from a cron expression, starting from `after`.
 * Returns null if the expression is invalid.
 */
export function nextCronTime(cronExpr: string, after: Date = new Date()): Date | null {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  try {
    const minutes = parseCronField(parts[0], 0, 59);
    const hours = parseCronField(parts[1], 0, 23);
    const daysOfMonth = parseCronField(parts[2], 1, 31);
    const months = parseCronField(parts[3], 1, 12);
    const daysOfWeek = parseCronField(parts[4], 0, 6); // 0=Sunday

    // Search forward from `after` + 1 minute, up to 1 year
    const start = new Date(after);
    start.setSeconds(0, 0);
    start.setMinutes(start.getMinutes() + 1);

    const limit = new Date(after);
    limit.setFullYear(limit.getFullYear() + 1);

    const current = new Date(start);
    while (current < limit) {
      if (
        months.includes(current.getMonth() + 1) &&
        daysOfMonth.includes(current.getDate()) &&
        daysOfWeek.includes(current.getDay()) &&
        hours.includes(current.getHours()) &&
        minutes.includes(current.getMinutes())
      ) {
        return current;
      }
      current.setMinutes(current.getMinutes() + 1);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Human-readable description of a cron expression.
 */
export function describeCron(cronExpr: string): string {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return cronExpr;

  const [min, hour, dom, mon, dow] = parts;

  // Common patterns
  if (min === "0" && hour !== "*" && dom === "*" && mon === "*" && dow === "*") {
    return `Diariamente as ${hour}:00`;
  }
  if (min !== "*" && hour !== "*" && dom === "*" && mon === "*" && dow === "*") {
    return `Diariamente as ${hour}:${min.padStart(2, "0")}`;
  }
  if (dom === "*" && mon === "*" && dow !== "*") {
    const days = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sab"];
    const dayList = dow.split(",").map((d) => days[parseInt(d)] || d).join(", ");
    return `${dayList} as ${hour === "*" ? "**" : hour}:${min === "*" ? "**" : min.padStart(2, "0")}`;
  }
  if (min.startsWith("*/")) {
    return `A cada ${min.replace("*/", "")} minutos`;
  }
  if (hour.startsWith("*/")) {
    return `A cada ${hour.replace("*/", "")} horas`;
  }

  return cronExpr;
}

// ==================== Helpers ====================

function generateId(): string {
  return randomBytes(16).toString("hex");
}

function rowToSchedule(row: any): Schedule {
  return {
    id: row.id,
    name: row.name,
    userId: row.user_id,
    cron: row.cron,
    taskText: row.task_text,
    executionMode: row.execution_mode || "build",
    active: row.active === true || row.active === 1,
    maxConcurrent: row.max_concurrent || 1,
    lastRunAt: row.last_run_at || null,
    nextRunAt: row.next_run_at || null,
    runCount: row.run_count || 0,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ==================== Service ====================

export class ScheduleService {
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private triggerCallback: ((schedule: Schedule) => Promise<void>) | null = null;

  /**
   * Register the callback that fires when a schedule triggers.
   * Called by Agent after initialization.
   */
  setTriggerCallback(cb: (schedule: Schedule) => Promise<void>): void {
    this.triggerCallback = cb;
  }

  /**
   * Start the scheduler tick (runs every 60 seconds).
   */
  start(): void {
    if (this.tickTimer) return;
    logger.info("Scheduler engine started (60s tick)");
    // Run an initial check after 10 seconds (let the app fully start)
    setTimeout(() => this.tick(), 10_000);
    this.tickTimer = setInterval(() => this.tick(), 60_000);
  }

  /**
   * Stop the scheduler.
   */
  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  /**
   * Check all active schedules and trigger those that are due.
   */
  private async tick(): Promise<void> {
    try {
      const now = new Date();
      const result = await query(
        `SELECT * FROM schedules WHERE active = TRUE AND next_run_at IS NOT NULL AND next_run_at <= $1`,
        [now.toISOString()]
      );

      for (const row of result.rows) {
        const schedule = rowToSchedule(row);
        // Compute next run time before triggering (prevents re-triggering)
        const nextRun = nextCronTime(schedule.cron, now);
        await query(
          `UPDATE schedules SET last_run_at = NOW(), run_count = run_count + 1, next_run_at = $1, updated_at = NOW() WHERE id = $2`,
          [nextRun ? nextRun.toISOString() : null, schedule.id]
        );

        logger.info({ scheduleId: schedule.id, name: schedule.name }, "Schedule triggered");

        if (this.triggerCallback) {
          this.triggerCallback(schedule).catch((err) => {
            logger.error({ err, scheduleId: schedule.id }, "Schedule trigger callback failed");
          });
        }
      }
    } catch (err) {
      logger.warn({ err }, "Scheduler tick error");
    }
  }

  // ==================== CRUD ====================

  async create(input: ScheduleCreateInput, actorId: number): Promise<Schedule> {
    const id = generateId();

    // Validate cron
    const nextRun = nextCronTime(input.cron);
    if (!nextRun) {
      throw new Error("Expressao cron invalida: " + input.cron);
    }

    // Create dedicated internal user
    const userResult = await query(
      `INSERT INTO users (phone, display_name, role, status, created_at, updated_at)
       VALUES ($1, $2, 'internal', 'active', NOW(), NOW()) RETURNING id`,
      [`schedule:${id}`, `Schedule: ${input.name}`]
    );
    const internalUserId = userResult.rows[0].id;

    await query(
      `INSERT INTO connector_identities (user_id, connector, external_id, display_name, created_at)
       VALUES ($1, 'schedule', $2, $3, NOW())`,
      [internalUserId, id, input.name]
    );

    await query(
      `INSERT INTO schedules (id, name, user_id, cron, task_text, execution_mode, active, max_concurrent, next_run_at, run_count, created_by, updated_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7, $8, 0, $9, $9, NOW(), NOW())`,
      [id, input.name, internalUserId, input.cron, input.taskText, input.executionMode || "build", input.maxConcurrent || 1, nextRun.toISOString(), actorId]
    );

    await this.audit("schedule", id, "create", actorId, { name: input.name, cron: input.cron });
    logger.info({ scheduleId: id, name: input.name, cron: input.cron, nextRun: nextRun.toISOString(), actorId }, "Schedule created");
    return this.getById(id) as Promise<Schedule>;
  }

  async update(id: string, input: ScheduleUpdateInput, actorId: number, actorRole: UserRole): Promise<Schedule | null> {
    const existing = await this.getById(id);
    if (!existing) return null;

    if (!await this.canModify(existing, actorId, actorRole)) {
      throw new Error("Permissao negada: apenas o admin pode modificar agendamentos criados por admin.");
    }

    const sets: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;
    const changes: Record<string, any> = {};

    if (input.name !== undefined && input.name !== existing.name) {
      sets.push(`name = $${paramIdx++}`);
      params.push(input.name);
      changes.name = { from: existing.name, to: input.name };
      await query(`UPDATE users SET display_name = $1, updated_at = NOW() WHERE id = $2`, [`Schedule: ${input.name}`, existing.userId]);
    }
    if (input.cron !== undefined && input.cron !== existing.cron) {
      const nextRun = nextCronTime(input.cron);
      if (!nextRun) throw new Error("Expressao cron invalida: " + input.cron);
      sets.push(`cron = $${paramIdx++}`);
      params.push(input.cron);
      sets.push(`next_run_at = $${paramIdx++}`);
      params.push(nextRun.toISOString());
      changes.cron = { from: existing.cron, to: input.cron };
    }
    if (input.taskText !== undefined && input.taskText !== existing.taskText) {
      sets.push(`task_text = $${paramIdx++}`);
      params.push(input.taskText);
      changes.taskText = { from: existing.taskText.substring(0, 50), to: input.taskText.substring(0, 50) };
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
      // Recalculate next_run_at if being activated
      if (input.active) {
        const nextRun = nextCronTime(input.cron || existing.cron);
        if (nextRun) {
          sets.push(`next_run_at = $${paramIdx++}`);
          params.push(nextRun.toISOString());
        }
      }
    }
    if (input.maxConcurrent !== undefined && input.maxConcurrent !== existing.maxConcurrent) {
      sets.push(`max_concurrent = $${paramIdx++}`);
      params.push(input.maxConcurrent);
      changes.maxConcurrent = { from: existing.maxConcurrent, to: input.maxConcurrent };
    }

    if (sets.length === 0) return existing;

    sets.push(`updated_by = $${paramIdx++}`);
    params.push(actorId);
    sets.push(`updated_at = NOW()`);
    params.push(id);

    await query(`UPDATE schedules SET ${sets.join(", ")} WHERE id = $${paramIdx}`, params);
    await this.audit("schedule", id, "update", actorId, changes);

    logger.info({ scheduleId: id, actorId, changes }, "Schedule updated");
    return this.getById(id);
  }

  async delete(id: string, actorId: number, actorRole: UserRole): Promise<boolean> {
    const existing = await this.getById(id);
    if (!existing) return false;

    if (!await this.canModify(existing, actorId, actorRole)) {
      throw new Error("Permissao negada: apenas o admin pode apagar agendamentos criados por admin.");
    }

    await query(`DELETE FROM schedules WHERE id = $1`, [id]);
    await query(`DELETE FROM connector_identities WHERE connector = 'schedule' AND external_id = $1`, [id]);

    await this.audit("schedule", id, "delete", actorId, { name: existing.name });
    logger.info({ scheduleId: id, actorId }, "Schedule deleted");
    return true;
  }

  async getById(id: string): Promise<Schedule | null> {
    const result = await query(`SELECT * FROM schedules WHERE id = $1`, [id]);
    if (result.rows.length === 0) return null;
    return rowToSchedule(result.rows[0]);
  }

  async list(): Promise<Schedule[]> {
    const result = await query(`SELECT * FROM schedules ORDER BY created_at DESC`);
    return result.rows.map(rowToSchedule);
  }

  /**
   * Trigger a schedule manually (bypasses cron, runs immediately).
   */
  async triggerManual(id: string, actorId: number): Promise<void> {
    const schedule = await this.getById(id);
    if (!schedule) throw new Error("Agendamento nao encontrado");

    await query(
      `UPDATE schedules SET last_run_at = NOW(), run_count = run_count + 1, updated_at = NOW() WHERE id = $1`,
      [id]
    );

    await this.audit("schedule", id, "manual_trigger", actorId, {});
    logger.info({ scheduleId: id, actorId }, "Schedule manually triggered");

    if (this.triggerCallback) {
      await this.triggerCallback(schedule);
    }
  }

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

  private async canModify(schedule: Schedule, actorId: number, actorRole: UserRole): Promise<boolean> {
    if (actorRole === "admin") return true;
    const creatorResult = await query(`SELECT role FROM users WHERE id = $1`, [schedule.createdBy]);
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
