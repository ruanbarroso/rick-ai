import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "./config/logger.js";
import { query } from "./memory/database.js";
import { config } from "./config/env.js";
import { configGet, configSet } from "./memory/config-store.js";
import { verifyAgentToken, type AgentTokenPayload } from "./subagent/agent-token.js";
import { resolveSessionsToken, getSessionVariantName, getMainSessionName } from "./subagent/session-manager.js";
import type { SubAgentMetricsSnapshot } from "./subagent/types.js";
import type { MemoryService } from "./memory/memory-service.js";
import type { VectorMemoryService } from "./memory/vector-memory-service.js";
import { claudeOAuthService, openaiOAuthService } from "./auth/oauth-singleton.js";
import type { UserRole } from "./auth/permissions.js";
import { WebhookService, renderTemplate } from "./automation/webhook-service.js";
import { ScheduleService } from "./automation/schedule-service.js";

/**
 * HTTP server that serves:
 *   GET /health  → Health check (used by deploy pipeline + Docker healthcheck)
 *   GET /        → Web UI (single HTML file)
 *   GET /api/code/export → Download source as zip
 *   POST /api/code/import → Upload zip and deploy
 *   *            → 404
 *
 * Also exports the raw http.Server so the WebConnector can attach
 * a WebSocket server for real-time chat via 'upgrade' events.
 */

interface HealthState {
  /** App has completed initialization (DB ready, config loaded, connectors started) */
  ready: boolean;
  whatsappConnected: boolean;
  postgresConnected: boolean;
  pgvectorConnected: boolean;
  startedAt: number;
}

const state: HealthState = {
  ready: false,
  whatsappConnected: false,
  postgresConnected: false,
  pgvectorConnected: false,
  startedAt: Date.now(),
};

export function setHealthy(key: keyof Omit<HealthState, "startedAt">, value: boolean): void {
  state[key] = value;
}

/**
 * The app is healthy if the database is ready (postgresConnected covers both
 * PostgreSQL and SQLite — set to true after migrations complete).
 * WhatsApp and pgvector are optional services and do NOT gate health.
 */
export function isHealthy(): boolean {
  return state.postgresConnected;
}

/** Cached HTML files (loaded once at first request) */
let cachedHtml: string | null = null;
let cachedSessionHtml: string | null = null;
let cachedSessionsListHtml: string | null = null;
let cachedMainSessionHtml: string | null = null;

async function loadHtml(filename: string): Promise<string | null> {
  const paths = [
    join(process.cwd(), "dist", "connectors", filename),
    join(process.cwd(), "src", "connectors", filename),
  ];
  for (const p of paths) {
    try {
      const content = await readFile(p, "utf-8");
      logger.info({ path: p }, `${filename} loaded`);
      return content;
    } catch {
      // try next path
    }
  }
  return null;
}

async function getWebUiHtml(): Promise<string> {
  if (cachedHtml) return cachedHtml;
  cachedHtml = await loadHtml("web-ui.html");
  if (!cachedHtml) {
    logger.error("web-ui.html not found");
    return "<html><body><h1>Web UI not found</h1></body></html>";
  }
  return cachedHtml;
}

async function getSessionViewerHtml(): Promise<string> {
  if (cachedSessionHtml) return cachedSessionHtml;
  cachedSessionHtml = await loadHtml("session-viewer.html");
  if (!cachedSessionHtml) {
    logger.error("session-viewer.html not found");
    return "<html><body><h1>Session viewer not found</h1></body></html>";
  }
  return cachedSessionHtml;
}

async function getSessionsListHtml(): Promise<string> {
  if (cachedSessionsListHtml) return cachedSessionsListHtml;
  cachedSessionsListHtml = await loadHtml("sessions-list.html");
  if (!cachedSessionsListHtml) {
    logger.error("sessions-list.html not found");
    return "<html><body><h1>Sessions list not found</h1></body></html>";
  }
  return cachedSessionsListHtml;
}

async function getMainSessionViewerHtml(): Promise<string> {
  if (cachedMainSessionHtml) return cachedMainSessionHtml;
  cachedMainSessionHtml = await loadHtml("main-session-viewer.html");
  if (!cachedMainSessionHtml) {
    logger.error("main-session-viewer.html not found");
    return "<html><body><h1>Main session viewer not found</h1></body></html>";
  }
  return cachedMainSessionHtml;
}

/**
 * The shared HTTP server instance. Exported so WebConnector can
 * listen for 'upgrade' events to handle WebSocket connections.
 */
export let httpServer: Server | null = null;

// ==================== AGENT API SERVICE REGISTRY ====================
// Services are registered after init (startHealthServer runs before services are created).
let registeredMemoryService: MemoryService | null = null;
let registeredVectorMemory: VectorMemoryService | null = null;
let registeredKillSession: ((sessionId: string) => Promise<void>) | null = null;
let registeredSubagentMetrics: (() => SubAgentMetricsSnapshot) | null = null;
let registeredSessionStateGetter: ((sessionId: string) => string | null) | null = null;
let registeredBroadcast: ((data: object) => void) | null = null;
let registeredWebhookService: WebhookService | null = null;
let registeredScheduleService: ScheduleService | null = null;
let registeredAdminUserId: number | null = null;
let registeredWebhookTrigger: ((webhook: any, payload: any) => Promise<string>) | null = null;

/**
 * Register services for the sub-agent Agent API (read + write).
 * Called from index.ts after MemoryService and VectorMemoryService are initialized.
 */
export function registerAgentApiServices(
  memory: MemoryService,
  vectorMemory?: VectorMemoryService,
): void {
  registeredMemoryService = memory;
  registeredVectorMemory = vectorMemory ?? null;
  logger.info(
    { hasVectorMemory: !!vectorMemory },
    "Agent API services registered",
  );
}

/**
 * Register the session kill function so public API can kill sessions.
 * Called from index.ts after SessionManager is initialized.
 */
export function registerSessionKiller(killFn: (sessionId: string) => Promise<void>): void {
  registeredKillSession = killFn;
}

export function registerSubagentMetrics(getter: () => SubAgentMetricsSnapshot): void {
  registeredSubagentMetrics = getter;
}

export function registerAutomationServices(
  webhookService: WebhookService,
  scheduleService: ScheduleService,
  adminUserId: number,
  webhookTrigger: (webhook: any, payload: any) => Promise<string>,
): void {
  registeredWebhookService = webhookService;
  registeredScheduleService = scheduleService;
  registeredAdminUserId = adminUserId;
  registeredWebhookTrigger = webhookTrigger;
  logger.info("Automation services registered (webhooks + schedules)");
}

/**
 * Register a broadcast function to send messages to all authenticated WebSocket clients.
 * Used by the auto-updater to notify clients of update status.
 */
export function registerBroadcast(fn: (data: object) => void): void {
  registeredBroadcast = fn;
}

/**
 * Register a getter for live in-memory session state (running, waiting_user, etc.).
 * The sessions API uses this to return fine-grained state for active sessions
 * instead of the coarse DB status ('active').
 */
export function registerSessionStateGetter(getter: (sessionId: string) => string | null): void {
  registeredSessionStateGetter = getter;
}

export function startHealthServer(port: number): void {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/health" && req.method === "GET") {
      const healthy = isHealthy();
      const uptimeSeconds = Math.round((Date.now() - state.startedAt) / 1000);

      const body = JSON.stringify({
        status: healthy ? "ok" : "unhealthy",
        ready: state.ready,
        uptime: uptimeSeconds,
        whatsapp: state.whatsappConnected,
        postgres: state.postgresConnected,
        pgvector: state.pgvectorConnected,
        subagent: registeredSubagentMetrics ? registeredSubagentMetrics().gauges : null,
      });

      res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
      res.end(body);
      return;
    }

    if ((req.url === "/" || req.url === "/index.html") && req.method === "GET") {
      const html = await getWebUiHtml();
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      res.end(html);
      return;
    }

    // Public sub-agent session viewer: /s/:sessionId
    if (req.url?.startsWith("/s/") && req.method === "GET") {
      const html = await getSessionViewerHtml();
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      res.end(html);
      return;
    }

    // Public sessions dashboard: /u/:token
    if (req.url?.startsWith("/u/") && req.method === "GET") {
      const html = await getSessionsListHtml();
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      res.end(html);
      return;
    }

    // Public main session viewer: /m/:token
    if (req.url?.startsWith("/m/") && req.method === "GET") {
      const html = await getMainSessionViewerHtml();
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      res.end(html);
      return;
    }

    // Public sessions API: /api/sessions/:token
    const sessionsApiMatch = req.url?.match(/^\/api\/sessions\/([a-f0-9]{16})$/);
    if (sessionsApiMatch && req.method === "GET") {
      await handlePublicSessionsApi(sessionsApiMatch[1], res);
      return;
    }

    // Public session kill API: POST /api/sessions/:token/kill/:sessionId
    const killApiMatch = req.url?.match(/^\/api\/sessions\/([a-f0-9]{16})\/kill\/([a-f0-9]+)$/);
    if (killApiMatch && req.method === "POST") {
      await handlePublicKillSession(killApiMatch[1], killApiMatch[2], res);
      return;
    }

    // Shared static assets (CSS/JS used by both web-ui.html and session-viewer.html)
    if (req.url?.startsWith("/static/") && req.method === "GET") {
      const filename = req.url.slice("/static/".length);
      // Whitelist: only serve known files, no path traversal
      if (/^[\w-]+\.(css|js)$/.test(filename)) {
        const ext = filename.endsWith(".css") ? "css" : "js";
        const mime = ext === "css" ? "text/css" : "application/javascript";
        const paths = [
          join(process.cwd(), "dist", "connectors", "static", filename),
          join(process.cwd(), "src", "connectors", "static", filename),
        ];
        for (const p of paths) {
          try {
            const content = await readFile(p, "utf-8");
            res.writeHead(200, { "Content-Type": `${mime}; charset=utf-8`, "Cache-Control": "public, max-age=3600" });
            res.end(content);
            return;
          } catch { /* try next */ }
        }
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }

    // Media blob endpoint: /audio/:id, /img/:id or /file/:id (all use audio_blobs table)
    const mediaMatch = req.url?.match(/^\/(audio|img|file)\/([a-f0-9]{16})$/);
    if (mediaMatch && req.method === "GET") {
      try {
        const result = await query(
          `SELECT data, mime_type FROM audio_blobs WHERE id = $1`,
          [mediaMatch[2]]
        );
        if (result.rows.length === 0) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        const { data, mime_type } = result.rows[0];
        const buffer: Buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const totalLength = buffer.length;
        const rangeHeader = req.headers["range"];

        if (rangeHeader) {
          const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
          if (match) {
            const start = match[1] ? parseInt(match[1], 10) : Math.max(0, totalLength - parseInt(match[2] || "0", 10));
            const end = match[2] ? Math.min(parseInt(match[2], 10), totalLength - 1) : totalLength - 1;
            const chunkLength = end - start + 1;
            res.writeHead(206, {
              "Content-Type": mime_type,
              "Content-Range": `bytes ${start}-${end}/${totalLength}`,
              "Accept-Ranges": "bytes",
              "Content-Length": chunkLength,
              "Cache-Control": "public, max-age=31536000, immutable",
            });
            res.end(buffer.subarray(start, end + 1));
            return;
          }
        }

        const responseHeaders: Record<string, string | number> = {
          "Content-Type": mime_type,
          "Content-Length": totalLength,
          "Accept-Ranges": "bytes",
          "Cache-Control": "public, max-age=31536000, immutable",
        };
        // For generic file downloads, add Content-Disposition so browser prompts download
        if (mediaMatch[1] === "file") {
          responseHeaders["Content-Disposition"] = "attachment";
        }
        res.writeHead(200, responseHeaders);
        res.end(buffer);
      } catch (err) {
        logger.error({ err }, "Failed to serve media blob");
        res.writeHead(500);
        res.end("Internal error");
      }
      return;
    }

    // ==================== VERSION CHECK ====================
    if (req.url?.startsWith("/api/version") && req.method === "GET") {
      if (!authenticateRequest(req, res)) return;
      await handleVersionCheck(res);
      return;
    }

    // ==================== CODE EXPORT ====================
    if (req.url?.startsWith("/api/code/export") && req.method === "GET") {
      if (!authenticateRequest(req, res)) return;
      await handleCodeExport(res);
      return;
    }

    // ==================== CODE IMPORT ====================
    if (req.url?.startsWith("/api/code/import") && req.method === "POST") {
      if (!authenticateRequest(req, res)) return;
      await handleCodeImport(req, res);
      return;
    }

    // ==================== UPDATE (download from GitHub + import) ====================
    if (req.url?.startsWith("/api/update") && req.method === "POST") {
      if (!authenticateRequest(req, res)) return;
      await handleUpdate(req, res);
      return;
    }

    // ==================== AUTO-UPDATE CONFIG ====================
    if (req.url?.startsWith("/api/auto-update") && req.method === "GET") {
      if (!authenticateRequest(req, res)) return;
      await handleAutoUpdateGet(res);
      return;
    }
    if (req.url?.startsWith("/api/auto-update") && req.method === "POST") {
      if (!authenticateRequest(req, res)) return;
      await handleAutoUpdateSet(req, res);
      return;
    }

    // ==================== SUB-AGENT METRICS ====================
    if (req.url?.startsWith("/api/subagent/metrics") && req.method === "GET") {
      if (!authenticateRequest(req, res)) return;
      if (!registeredSubagentMetrics) {
        jsonResponse(res, 503, { error: "Metricas de subagente indisponiveis" });
        return;
      }
      jsonResponse(res, 200, registeredSubagentMetrics());
      return;
    }

    // ==================== WEBHOOK TRIGGER (Bearer secret) ====================
    const webhookTriggerMatch = req.url?.match(/^\/api\/webhook\/([a-f0-9]+)$/);
    if (webhookTriggerMatch && req.method === "POST") {
      const webhookId = webhookTriggerMatch[1];
      const authHeader = req.headers["authorization"] || "";
      const secretMatch = authHeader.match(/^Bearer\s+(.+)$/i);
      if (!secretMatch) {
        jsonResponse(res, 401, { error: "Bearer token obrigatorio" });
        return;
      }
      if (!registeredWebhookService || !registeredWebhookTrigger) {
        jsonResponse(res, 503, { error: "Servico de webhooks indisponivel" });
        return;
      }
      const webhook = await registeredWebhookService.getBySecret(webhookId, secretMatch[1]);
      if (!webhook) {
        jsonResponse(res, 404, { error: "Webhook nao encontrado ou secret invalido" });
        return;
      }
      if (!webhook.active) {
        jsonResponse(res, 409, { error: "Webhook desativado" });
        return;
      }
      try {
        const body = (await readRequestBody(req)).toString("utf-8");
        const payload = body ? JSON.parse(body) : {};
        const renderedText = renderTemplate(webhook.template, payload);
        const sessionId = await registeredWebhookTrigger(webhook, { text: renderedText, payload });
        await registeredWebhookService.recordTrigger(webhook.id);
        jsonResponse(res, 200, { ok: true, sessionId, text: renderedText.substring(0, 200) });
      } catch (err: any) {
        logger.error({ err, webhookId }, "Webhook trigger failed");
        jsonResponse(res, 500, { error: err.message || "Erro ao disparar webhook" });
      }
      return;
    }

    // ==================== WEBHOOKS MANAGEMENT API ====================
    if (req.url?.startsWith("/api/webhooks") && (req.method === "GET" || req.method === "POST" || req.method === "PUT" || req.method === "DELETE")) {
      const actor = await authenticateAutomationRequest(req, res);
      if (!actor) return;
      if (!registeredWebhookService) {
        jsonResponse(res, 503, { error: "Servico de webhooks indisponivel" });
        return;
      }
      const actorId = actor.userId;
      const actorRole = actor.role;

      try {
        // GET /api/webhooks — list all
        if (req.method === "GET" && req.url?.match(/^\/api\/webhooks(\?|$)/)) {
          const webhooks = await registeredWebhookService.list();
          jsonResponse(res, 200, { webhooks });
          return;
        }

        // GET /api/webhooks/:id/audit — audit log
        const auditMatch = req.url?.match(/^\/api\/webhooks\/([a-f0-9]+)\/audit/);
        if (req.method === "GET" && auditMatch) {
          const log = await registeredWebhookService.getAuditLog("webhook", auditMatch[1]);
          jsonResponse(res, 200, { log });
          return;
        }

        // POST /api/webhooks — create
        if (req.method === "POST" && req.url?.match(/^\/api\/webhooks(\?|$)/)) {
          const body = JSON.parse((await readRequestBody(req)).toString("utf-8") || "{}");
          const webhook = await registeredWebhookService.create(body, actorId);
          jsonResponse(res, 201, { webhook });
          return;
        }

        // PUT /api/webhooks/:id — update
        const putMatch = req.url?.match(/^\/api\/webhooks\/([a-f0-9]+)/);
        if (req.method === "PUT" && putMatch) {
          const body = JSON.parse((await readRequestBody(req)).toString("utf-8") || "{}");
          const webhook = await registeredWebhookService.update(putMatch[1], body, actorId, actorRole);
          if (!webhook) { jsonResponse(res, 404, { error: "Webhook nao encontrado" }); return; }
          jsonResponse(res, 200, { webhook });
          return;
        }

        // DELETE /api/webhooks/:id — delete
        const delMatch = req.url?.match(/^\/api\/webhooks\/([a-f0-9]+)/);
        if (req.method === "DELETE" && delMatch) {
          const ok = await registeredWebhookService.delete(delMatch[1], actorId, actorRole);
          if (!ok) { jsonResponse(res, 404, { error: "Webhook nao encontrado" }); return; }
          jsonResponse(res, 200, { ok: true });
          return;
        }
      } catch (err: any) {
        jsonResponse(res, 400, { error: err.message });
        return;
      }
      jsonResponse(res, 404, { error: "Endpoint nao encontrado" });
      return;
    }

    // ==================== SCHEDULES MANAGEMENT API ====================
    if (req.url?.startsWith("/api/schedules") && (req.method === "GET" || req.method === "POST" || req.method === "PUT" || req.method === "DELETE")) {
      const actor = await authenticateAutomationRequest(req, res);
      if (!actor) return;
      if (!registeredScheduleService) {
        jsonResponse(res, 503, { error: "Servico de agendamentos indisponivel" });
        return;
      }
      const actorId = actor.userId;
      const actorRole = actor.role;

      try {
        // GET /api/schedules — list all
        if (req.method === "GET" && req.url?.match(/^\/api\/schedules(\?|$)/)) {
          const schedules = await registeredScheduleService.list();
          jsonResponse(res, 200, { schedules });
          return;
        }

        // GET /api/schedules/:id/audit — audit log
        const auditMatch = req.url?.match(/^\/api\/schedules\/([a-f0-9]+)\/audit/);
        if (req.method === "GET" && auditMatch) {
          const log = await registeredScheduleService.getAuditLog("schedule", auditMatch[1]);
          jsonResponse(res, 200, { log });
          return;
        }

        // POST /api/schedules — create
        if (req.method === "POST" && req.url?.match(/^\/api\/schedules(\?|$)/)) {
          const body = JSON.parse((await readRequestBody(req)).toString("utf-8") || "{}");
          const schedule = await registeredScheduleService.create(body, actorId);
          jsonResponse(res, 201, { schedule });
          return;
        }

        // POST /api/schedules/:id/trigger — manual trigger
        const triggerMatch = req.url?.match(/^\/api\/schedules\/([a-f0-9]+)\/trigger/);
        if (req.method === "POST" && triggerMatch) {
          await registeredScheduleService.triggerManual(triggerMatch[1], actorId);
          jsonResponse(res, 200, { ok: true });
          return;
        }

        // PUT /api/schedules/:id — update
        const putMatch = req.url?.match(/^\/api\/schedules\/([a-f0-9]+)/);
        if (req.method === "PUT" && putMatch) {
          const body = JSON.parse((await readRequestBody(req)).toString("utf-8") || "{}");
          const schedule = await registeredScheduleService.update(putMatch[1], body, actorId, actorRole);
          if (!schedule) { jsonResponse(res, 404, { error: "Agendamento nao encontrado" }); return; }
          jsonResponse(res, 200, { schedule });
          return;
        }

        // DELETE /api/schedules/:id — delete
        const delMatch = req.url?.match(/^\/api\/schedules\/([a-f0-9]+)/);
        if (req.method === "DELETE" && delMatch) {
          const ok = await registeredScheduleService.delete(delMatch[1], actorId, actorRole);
          if (!ok) { jsonResponse(res, 404, { error: "Agendamento nao encontrado" }); return; }
          jsonResponse(res, 200, { ok: true });
          return;
        }
      } catch (err: any) {
        jsonResponse(res, 400, { error: err.message });
        return;
      }
      jsonResponse(res, 404, { error: "Endpoint nao encontrado" });
      return;
    }

    // ==================== WEBHOOKS / SCHEDULES HTML PAGES ====================
    if (req.url?.startsWith("/webhooks") && req.method === "GET") {
      const filePath = join(import.meta.dirname, "connectors", "webhooks.html");
      try {
        const html = await readFile(filePath, "utf-8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      } catch {
        res.writeHead(404);
        res.end("Not found");
      }
      return;
    }
    if (req.url?.startsWith("/schedules") && req.method === "GET") {
      const filePath = join(import.meta.dirname, "connectors", "schedules.html");
      try {
        const html = await readFile(filePath, "utf-8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      } catch {
        res.writeHead(404);
        res.end("Not found");
      }
      return;
    }

    // ==================== AGENT API (JWT-authenticated) ====================
    // Endpoints for sub-agents to query/write
    // memories, credentials, config, conversations, semantic search, and LLM tokens.
    // Authentication uses Bearer JWT tokens, NOT the web UI password.

    if (req.url?.startsWith("/api/agent/") && req.method === "GET") {
      const agentSession = authenticateAgentRequest(req, res);
      if (!agentSession) return;
      await handleAgentApiGet(req, res, agentSession);
      return;
    }

    if (req.url?.startsWith("/api/agent/") && req.method === "POST") {
      const agentSession = authenticateAgentRequest(req, res);
      if (!agentSession) return;
      await handleAgentApiPost(req, res, agentSession);
      return;
    }

    if (req.url?.startsWith("/api/agent/") && req.method === "DELETE") {
      const agentSession = authenticateAgentRequest(req, res);
      if (!agentSession) return;
      await handleAgentApiDelete(req, res, agentSession);
      return;
    }

    // ==================== PUBLIC IDENTITY (no auth) ====================
    // Returns the agent's display name and logo so the login screen can show
    // the correct branding on the very first visit (before localStorage is populated).
    if (req.url === "/api/identity" && req.method === "GET") {
      try {
        const logo = await configGet("AGENT_LOGO") || "";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ name: config.agentName, logo }));
      } catch {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ name: config.agentName || "Rick", logo: "" }));
      }
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  httpServer = server;

  server.listen(port, () => {
    logger.info({ port }, "HTTP server started (health + web UI)");
  });
}

// ==================== AUTH HELPER ====================

/**
 * Authenticate automation management requests (webhooks, schedules).
 * Accepts either:
 *   - Admin password via ?token=<password> (admin role)
 *   - Sessions token via ?t=<sessionsToken> (resolves to user, checks canManageAutomations)
 * Returns { userId, role } or null (401 already sent).
 */
async function authenticateAutomationRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<{ userId: number; role: UserRole } | null> {
  const url = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);

  // Try admin password first
  const passwordToken = url.searchParams.get("token");
  if (passwordToken && passwordToken === config.webAuthPassword) {
    return { userId: registeredAdminUserId || 1, role: "admin" };
  }

  // Try sessions token (for dev users)
  const sessionsToken = url.searchParams.get("t");
  if (sessionsToken) {
    const userId = await resolveSessionsToken(sessionsToken);
    if (userId != null) {
      // Look up user role
      const userResult = await query(`SELECT role FROM users WHERE id = $1`, [userId]);
      if (userResult.rows.length > 0) {
        const role = userResult.rows[0].role as UserRole;
        if (role === "admin" || role === "dev") {
          return { userId, role };
        }
      }
    }
  }

  jsonResponse(res, 401, { error: "Nao autorizado" });
  return null;
}

function authenticateRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);
  const token = url.searchParams.get("token");
  if (!token || token !== config.webAuthPassword) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Nao autorizado" }));
    return false;
  }
  return true;
}

// ==================== AGENT API AUTH (Bearer JWT) ====================

/**
 * Authenticate sub-agent requests via Bearer JWT token.
 * Uses Authorization header (not URL params) to avoid token leaks in logs.
 *
 * @returns Decoded token payload if valid, null if rejected (401 already sent).
 */
function authenticateAgentRequest(
  req: IncomingMessage,
  res: ServerResponse,
): AgentTokenPayload | null {
  const authHeader = req.headers["authorization"] || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Authorization header ausente ou invalido" }));
    return null;
  }

  const payload = verifyAgentToken(match[1]);
  if (!payload) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Token de sessao invalido ou expirado" }));
    return null;
  }

  return payload;
}

// ==================== AGENT API HANDLERS ====================

/**
 * Route handler for GET /api/agent/* endpoints.
 * Scoped to the JWT's userPhone; read-only except for /api/agent/memory (POST).
 */
async function handleAgentApiGet(
  req: IncomingMessage,
  res: ServerResponse,
  session: AgentTokenPayload,
): Promise<void> {
  const url = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);
  const path = url.pathname;

  try {
    // GET /api/agent/config — Operational configuration (no secrets)
    if (path === "/api/agent/config") {
      const safeConfig = {
        agentName: config.agentName,
        agentLanguage: config.agentLanguage,
        ownerPhone: config.ownerPhone,
        webBaseUrl: config.webBaseUrl,
      };
      logger.info({ sessionId: session.sessionId }, "Agent API: config requested");
      jsonResponse(res, 200, safeConfig);
      return;
    }

    // GET /api/agent/memories?category=x — List memories (decrypted)
    if (path === "/api/agent/memories") {
      if (!registeredMemoryService) {
        jsonResponse(res, 503, { error: "MemoryService nao disponivel" });
        return;
      }
      const category = url.searchParams.get("category") || undefined;
      const memories = await registeredMemoryService.listGlobalMemories(category);
      const result = memories.map((m: any) => ({
        key: m.key,
        value: m.value,
        category: m.category,
      }));
      logger.info(
        { sessionId: session.sessionId, category: category || "all", count: result.length },
        "Agent API: memories listed",
      );
      jsonResponse(res, 200, { memories: result });
      return;
    }

    // GET /api/agent/memory?category=x&key=y — Get specific memory
    if (path === "/api/agent/memory") {
      if (!registeredMemoryService) {
        jsonResponse(res, 503, { error: "MemoryService nao disponivel" });
        return;
      }
      const category = url.searchParams.get("category") || undefined;
      const key = url.searchParams.get("key") || "";
      if (!key) {
        jsonResponse(res, 400, { error: "Parametro 'key' e obrigatorio" });
        return;
      }
      const memories = await registeredMemoryService.listGlobalMemories(category);
      const found = memories.find(
        (m: any) => m.key.toLowerCase() === key.toLowerCase(),
      );
      logger.info(
        { sessionId: session.sessionId, category, key, found: !!found },
        "Agent API: memory lookup",
      );
      if (!found) {
        jsonResponse(res, 404, { error: "Memoria nao encontrada" });
        return;
      }
      jsonResponse(res, 200, { key: found.key, value: found.value, category: found.category });
      return;
    }

    // GET /api/agent/search?q=texto&limit=5 — Semantic vector search (falls back to keyword search)
    if (path === "/api/agent/search") {
      const q = url.searchParams.get("q") || "";
      if (!q) {
        jsonResponse(res, 400, { error: "Parametro 'q' e obrigatorio" });
        return;
      }
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "5"), 20);

      // Prefer pgvector semantic search when available
      if (registeredVectorMemory) {
        try {
          const results = await registeredVectorMemory.searchGlobal(q, limit);
          logger.info(
            { sessionId: session.sessionId, query: q, limit, count: results.length },
            "Agent API: semantic search",
          );
          jsonResponse(res, 200, {
            results: results.map((r: any) => ({
              content: r.content,
              category: r.category,
              source: r.source,
              similarity: r.similarity,
            })),
          });
          return;
        } catch (vecErr) {
          logger.warn({ err: vecErr, query: q }, "pgvector search failed, falling back to keyword search");
          // Fall through to keyword search below
        }
      }

      // Fallback: keyword search via MemoryService (works on SQLite)
      if (registeredMemoryService) {
        const memories = await registeredMemoryService.recallGlobal(q);
        const limited = memories.slice(0, limit);
        logger.info(
          { sessionId: session.sessionId, query: q, limit, count: limited.length, fallback: true },
          "Agent API: keyword search fallback (pgvector not configured)",
        );
        jsonResponse(res, 200, {
          results: limited.map((m: any) => ({
            content: `${m.key}: ${m.value}`,
            category: m.category,
            source: "memory",
            similarity: null,
          })),
        });
        return;
      }

      jsonResponse(res, 503, { error: "Busca nao disponivel (nenhum backend de memoria configurado)" });
      return;
    }

    // GET /api/agent/conversations?limit=20 — Recent conversation history
    if (path === "/api/agent/conversations") {
      if (!registeredMemoryService) {
        jsonResponse(res, 503, { error: "MemoryService nao disponivel" });
        return;
      }
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "20"), 100);
      const convUserId = await resolveUserId(session, registeredMemoryService);
      if (!convUserId) {
        jsonResponse(res, 503, { error: "MemoryService nao disponivel" });
        return;
      }
      const messages = await registeredMemoryService.getConversationHistoryByUserId(convUserId, limit);
      logger.info(
        { sessionId: session.sessionId, limit, count: messages.length },
        "Agent API: conversations requested",
      );
      jsonResponse(res, 200, { messages });
      return;
    }

    // GET /api/agent/llm-token?provider=claude|openai[&force=true]
    // Backward-compatible endpoint returning access token only.
    if (path === "/api/agent/llm-token") {
      const provider = url.searchParams.get("provider") || "claude";
      if (provider !== "claude" && provider !== "openai") {
        jsonResponse(res, 400, { error: "Provider invalido. Use 'claude' ou 'openai'" });
        return;
      }
      const forceRefresh = url.searchParams.get("force") === "true";

      // Use numericUserId from JWT when available to skip the DB lookup
      const userId = await resolveUserId(session, registeredMemoryService);
      if (!userId) {
        jsonResponse(res, 503, { error: "MemoryService nao disponivel para resolver usuario" });
        return;
      }

      // Try user's own token first, then fall back to shared token (user_id=NULL)
      const userIdsToTry: (number | null)[] = [userId, null];

      let accessToken: string | null = null;
      let accountId: string | null = null;
      for (const uid of userIdsToTry) {
        if (accessToken) break;
        if (provider === "claude") {
          accessToken = await claudeOAuthService.getValidToken(uid, forceRefresh);
        } else {
          const oauthToken = await openaiOAuthService.getValidToken(uid, forceRefresh);
          accessToken = oauthToken?.accessToken ?? null;
          accountId = oauthToken?.accountId ?? null;
        }
      }

      if (!accessToken) {
        jsonResponse(res, 404, { error: `Token OAuth nao disponivel para provider '${provider}'` });
        return;
      }

      logger.info({ sessionId: session.sessionId, provider, forceRefresh }, "Agent API: LLM token refreshed");
      const responseBody: Record<string, any> = { accessToken, provider };
      if (accountId) responseBody.accountId = accountId;
      jsonResponse(res, 200, responseBody);
      return;
    }

    // GET /api/agent/llm-auth-bundle?provider=claude|openai[&force=true]
    // Returns OAuth bundle in OpenCode-compatible shape (access+refresh+expiry).
    if (path === "/api/agent/llm-auth-bundle") {
      const provider = url.searchParams.get("provider") || "claude";
      if (provider !== "claude" && provider !== "openai") {
        jsonResponse(res, 400, { error: "Provider invalido. Use 'claude' ou 'openai'" });
        return;
      }
      const forceRefresh = url.searchParams.get("force") === "true";

      const userId = await resolveUserId(session, registeredMemoryService);
      if (!userId) {
        jsonResponse(res, 503, { error: "MemoryService nao disponivel para resolver usuario" });
        return;
      }

      // Try user's own token first, then fall back to shared token (user_id=NULL)
      const userIdsToTry: (number | null)[] = [userId, null];

      let auth: Record<string, any> | null = null;
      for (const uid of userIdsToTry) {
        if (auth) break;
        if (provider === "claude") {
          const bundle = await claudeOAuthService.getAuthBundle(uid, forceRefresh);
          if (bundle) {
            auth = {
              type: "oauth",
              accessToken: bundle.accessToken,
              refreshToken: bundle.refreshToken,
              expiresAt: bundle.expiresAt,
            };
          }
        } else {
          const bundle = await openaiOAuthService.getAuthBundle(uid, forceRefresh);
          if (bundle) {
            auth = {
              type: "oauth",
              accessToken: bundle.accessToken,
              refreshToken: bundle.refreshToken,
              expiresAt: bundle.expiresAt,
              accountId: bundle.accountId,
            };
          }
        }
      }

      if (!auth) {
        logger.info({ sessionId: session.sessionId, provider, forceRefresh }, "Agent API: LLM auth bundle not available (no OAuth)");
        jsonResponse(res, 404, { error: `OAuth nao disponivel para provider '${provider}'` });
        return;
      }

      logger.info({ sessionId: session.sessionId, provider, forceRefresh }, "Agent API: LLM auth bundle requested");
      jsonResponse(res, 200, { provider, auth });
      return;
    }

    // Unknown /api/agent/* path
    jsonResponse(res, 404, { error: "Endpoint nao encontrado" });
  } catch (err) {
    logger.error({ err, path, sessionId: session.sessionId }, "Agent API GET request failed");
    jsonResponse(res, 500, { error: "Erro interno" });
  }
}

/**
 * Route handler for POST /api/agent/* endpoints.
 * Allows sub-agents to write non-sensitive memories discovered during task execution.
 */
async function handleAgentApiPost(
  req: IncomingMessage,
  res: ServerResponse,
  session: AgentTokenPayload,
): Promise<void> {
  const url = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);
  const path = url.pathname;

  try {
    // POST /api/agent/memory — Save a new memory (principal validates overwrite rules).
    // Body: { key: string, value: string, category?: string }
    if (path === "/api/agent/memory") {
      if (!registeredMemoryService) {
        jsonResponse(res, 503, { error: "MemoryService nao disponivel" });
        return;
      }

      const rawBody = await readRequestBody(req);
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(rawBody.toString("utf-8") || "{}");
      } catch {
        jsonResponse(res, 400, { error: "JSON invalido no corpo da requisicao" });
        return;
      }

      const key: string = (String(body.key ?? "")).trim();
      const value: string = (String(body.value ?? "")).trim();
      const category: string = (String(body.category ?? "geral")).trim().toLowerCase();

      if (!key || !value) {
        jsonResponse(res, 400, { error: "Campos 'key' e 'value' sao obrigatorios" });
        return;
      }

      const userId = await resolveUserId(session, registeredMemoryService);
      if (!userId) {
        jsonResponse(res, 503, { error: "MemoryService nao disponivel para resolver usuario" });
        return;
      }
      const userRole = await resolveUserRole(userId);
      const result = await registeredMemoryService.rememberV2(
        key, value, category,
        userId,
        userRole,
        { source: "subagent", sessionId: session.sessionId },
      );

      if (result.blocked) {
        jsonResponse(res, 409, { error: "Memoria protegida por usuario com maior autoridade" });
        return;
      }

      logger.info({ sessionId: session.sessionId, category, key }, "Agent API: memory saved");
      jsonResponse(res, 200, { saved: true, key, category });
      return;
    }

    // Unknown /api/agent/* POST path
    jsonResponse(res, 404, { error: "Endpoint nao encontrado" });
  } catch (err) {
    logger.error({ err, path, sessionId: session.sessionId }, "Agent API POST request failed");
    jsonResponse(res, 500, { error: "Erro interno" });
  }
}

/**
 * Route handler for DELETE /api/agent/* endpoints.
 * Allows sub-agents to delete memories they identify as incorrect or outdated.
 */
async function handleAgentApiDelete(
  req: IncomingMessage,
  res: ServerResponse,
  session: AgentTokenPayload,
): Promise<void> {
  const url = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);
  const path = url.pathname;

  try {
    // DELETE /api/agent/memory?key=x&category=y — Delete a memory by key (optionally filtered by category)
    if (path === "/api/agent/memory") {
      if (!registeredMemoryService) {
        jsonResponse(res, 503, { error: "MemoryService nao disponivel" });
        return;
      }

      const key = url.searchParams.get("key")?.trim();
      const category = url.searchParams.get("category")?.trim() || undefined;

      if (!key) {
        jsonResponse(res, 400, { error: "Parametro 'key' e obrigatorio" });
        return;
      }

      const deleted = await registeredMemoryService.forgetGlobal(key, category);

      logger.info({ sessionId: session.sessionId, key, category, deleted }, "Agent API: memory deleted");
      jsonResponse(res, 200, { deleted, key, category: category || null });
      return;
    }

    // Unknown /api/agent/* DELETE path
    jsonResponse(res, 404, { error: "Endpoint nao encontrado" });
  } catch (err) {
    logger.error({ err, path, sessionId: session.sessionId }, "Agent API DELETE request failed");
    jsonResponse(res, 500, { error: "Erro interno" });
  }
}

// ==================== PUBLIC SESSIONS DASHBOARD API ====================

/**
 * GET /api/sessions/:token — Public API for sessions dashboard.
 * Resolves the deterministic token to a user_id, then returns all sessions
 * with their last user-message timestamp for ordering.
 */
async function handlePublicSessionsApi(token: string, res: ServerResponse): Promise<void> {
  try {
    const userId = await resolveSessionsToken(token);
    if (!userId) {
      jsonResponse(res, 404, { error: "Token invalido" });
      return;
    }

    const result = await query(
      `SELECT
         s.id,
         s.task,
         s.status,
         s.started_at,
         s.ended_at,
         s.connector_name,
         s.variant_name,
         MAX(CASE WHEN m.role = 'user' THEN m.created_at END) AS last_user_message,
         MAX(m.created_at) AS last_message_at
       FROM sub_agent_sessions s
       LEFT JOIN session_messages m ON m.session_id = s.id
       WHERE s.user_id = $1
       GROUP BY s.id, s.task, s.status, s.started_at, s.ended_at, s.connector_name, s.variant_name
       ORDER BY COALESCE(MAX(m.created_at), s.started_at) DESC`,
      [userId],
    );

    const sessions = await Promise.all(result.rows.map(async (r: any) => {
      // For active sessions, use the live in-memory state (running, waiting_user, etc.)
      // instead of the coarse DB value ('active'). This lets the dashboard show
      // "Digitando..." vs "Aguardando" vs "Online" accurately.
      let status = r.status;
      if (status === "active" && registeredSessionStateGetter) {
        const liveState = registeredSessionStateGetter(r.id);
        if (liveState) status = liveState;
      }
      return {
        id: r.id,
        task: r.task,
        status,
        startedAt: r.started_at,
        endedAt: r.ended_at,
        connectorName: r.connector_name,
        variantName: r.variant_name || await getSessionVariantName(r.id, userId),
        lastUserMessage: r.last_user_message,
        lastMessageAt: r.last_message_at,
      };
    }));

    const agentLogo = await configGet("AGENT_LOGO") || "";

    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
    });
    const mainSessionName = getMainSessionName();
    res.end(JSON.stringify({ agentName: config.agentName, agentLogo, mainSessionName, sessions }));
  } catch (err) {
    logger.error({ err, token }, "Failed to serve public sessions API");
    jsonResponse(res, 500, { error: "Erro interno" });
  }
}

/**
 * POST /api/sessions/:token/kill/:sessionId — Kill an active session.
 * Validates that the token resolves to the session's owner before killing.
 */
async function handlePublicKillSession(token: string, sessionId: string, res: ServerResponse): Promise<void> {
  try {
    if (!registeredKillSession) {
      jsonResponse(res, 503, { error: "Servico indisponivel" });
      return;
    }

    const userId = await resolveSessionsToken(token);
    if (!userId) {
      jsonResponse(res, 404, { error: "Token invalido" });
      return;
    }

    // Verify the session belongs to this user
    const result = await query(
      `SELECT user_id, status FROM sub_agent_sessions WHERE id = $1`,
      [sessionId],
    );
    if (result.rows.length === 0) {
      jsonResponse(res, 404, { error: "Sessao nao encontrada" });
      return;
    }
    if (result.rows[0].user_id !== userId) {
      jsonResponse(res, 403, { error: "Acesso negado" });
      return;
    }

    const status = result.rows[0].status;
    if (status === "killed" || status === "done") {
      jsonResponse(res, 200, { ok: true, already: true });
      return;
    }

    await registeredKillSession(sessionId);
    logger.info({ sessionId, userId, token }, "Session killed via public API");
    jsonResponse(res, 200, { ok: true });
  } catch (err) {
    logger.error({ err, token, sessionId }, "Failed to kill session via public API");
    jsonResponse(res, 500, { error: "Erro ao encerrar sessao" });
  }
}

/** Helper to send JSON responses. */
function jsonResponse(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

/** Read the full request body into a Buffer. */
async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/**
 * Resolve the numeric user ID for an Agent API request.
 * Uses the JWT's embedded numericUserId when present (no DB call);
 * falls back to getOrCreateUser for older tokens that don't carry it.
 * Returns null if the MemoryService is unavailable and the JWT has no ID.
 */
async function resolveUserId(
  session: AgentTokenPayload,
  memoryService: MemoryService | null,
): Promise<number | null> {
  if (session.numericUserId != null) return session.numericUserId;
  if (!memoryService) return null;
  const user = await memoryService.getOrCreateUser(session.userPhone);
  return user.id;
}

async function resolveUserRole(userId: number): Promise<UserRole> {
  try {
    const result = await query(
      "SELECT role FROM users WHERE id = $1 LIMIT 1",
      [userId],
    );
    const role = result.rows[0]?.role;
    if (role === "admin" || role === "dev") return role;
  } catch {
    // ignore and fall back
  }
  return "dev";
}

// ==================== VERSION ====================

const GITHUB_REPO = "ruanbarroso/rick-ai";
const VERSION_CACHE_FILE = ".rick-latest-version.json";

interface LatestVersionInfo {
  sha: string;
  fullSha?: string;
  date: string;
  message: string;
  checkedAt: string;
}

let _hostProjectDir: string | undefined;

/**
 * Return the HOST filesystem path to the project directory.
 * Auto-detects from Docker mount inspection when HOST_PROJECT_DIR is not set.
 */
async function getProjectDir(): Promise<string> {
  if (_hostProjectDir) return _hostProjectDir;

  const envDir = process.env.HOST_PROJECT_DIR;
  if (envDir) {
    _hostProjectDir = envDir;
    return envDir;
  }

  // Auto-detect from container mounts
  try {
    const execFileAsync = promisify(execFile);
    const { stdout: hostname } = await execFileAsync("cat", ["/etc/hostname"]);
    const containerId = hostname.trim();
    const { stdout: inspectJson } = await execFileAsync("docker", [
      "inspect", "--format", "{{json .Mounts}}", containerId,
    ]);
    const mounts = JSON.parse(inspectJson.trim()) as Array<{ Source: string; Destination: string }>;
    for (const m of mounts) {
      if (m.Destination === "/app/data") {
        const detected = m.Source.replace(/\/data$/, "");
        logger.info({ detected }, "Auto-detected HOST_PROJECT_DIR from container mounts");
        _hostProjectDir = detected;
        return detected;
      }
    }
  } catch (err) {
    logger.warn({ err }, "Failed to auto-detect HOST_PROJECT_DIR");
  }

  throw new Error(
    "HOST_PROJECT_DIR não está definido e não foi possível detectá-lo automaticamente."
  );
}

function getVersionCachePath(): string {
  // Write cache inside the container's own app dir (/app), not HOST_PROJECT_DIR
  // which points to the host filesystem and is inaccessible from inside the container.
  const appDir = process.cwd();
  return join(appDir, VERSION_CACHE_FILE);
}

async function fetchLatestFromGitHub(): Promise<LatestVersionInfo | null> {
  try {
    const headers: Record<string, string> = {
      "Accept": "application/vnd.github.v3+json",
      "User-Agent": "RickAI",
    };
    // Use GITHUB_TOKEN for authenticated requests (5000 req/hour vs 60 unauthenticated)
    const ghToken = process.env.GITHUB_TOKEN;
    if (ghToken) {
      headers["Authorization"] = `token ${ghToken}`;
    }
    const resp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/commits/main`, {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) {
      logger.warn({ status: resp.status, authenticated: !!ghToken }, "Version check: GitHub API returned non-OK");
      return null;
    }

    const data = await resp.json() as any;
    const fullSha = data.sha as string | undefined;
    if (!fullSha) return null;

    return {
      sha: fullSha.substring(0, 7),
      fullSha,
      date: data.commit?.committer?.date || "unknown",
      message: data.commit?.message?.split("\n")[0] || "",
      checkedAt: new Date().toISOString(),
    };
  } catch (err) {
    logger.warn({ err }, "Failed to fetch latest commit from GitHub");
    return null;
  }
}

async function readLatestVersionCache(): Promise<LatestVersionInfo | null> {
  try {
    const raw = await readFile(getVersionCachePath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<LatestVersionInfo>;
    if (!parsed || !parsed.sha || !parsed.date) return null;
    return {
      sha: parsed.sha,
      fullSha: parsed.fullSha,
      date: parsed.date,
      message: parsed.message || "",
      checkedAt: parsed.checkedAt || "unknown",
    };
  } catch {
    return null;
  }
}

async function writeLatestVersionCache(latest: LatestVersionInfo): Promise<void> {
  try {
    await writeFile(getVersionCachePath(), JSON.stringify(latest, null, 2), "utf-8");
  } catch (err) {
    logger.warn({ err }, "Failed to persist latest version cache");
  }
}

/**
 * Resolve current version from .rick-version file (preferred) or env vars (fallback).
 *
 * Priority: .rick-version > RICK_COMMIT_SHA env var > "unknown"
 *
 * Why .rick-version takes priority: after /publish, deploy.sh writes the new commit
 * SHA into .rick-version and injects it into the running container via docker exec.
 * But RICK_COMMIT_SHA is baked into the image at build time and can't be updated
 * without a full rebuild. So .rick-version is always the most current source.
 */
async function resolveCurrentVersion(): Promise<{ sha: string; date: string }> {
  // Try .rick-version first (updated by /publish and deploy.sh at runtime)
  try {
    const content = await readFile(".rick-version", "utf-8");
    const lines = content.trim().split("\n");
    const fileSha = lines[0]?.trim();
    const fileDate = lines[1]?.trim();
    if (fileSha && fileSha !== "unknown") {
      return {
        sha: fileSha,
        date: fileDate && fileDate !== "unknown" ? fileDate : process.env.RICK_COMMIT_DATE || "unknown",
      };
    }
  } catch {
    // .rick-version not found — fall through to env vars
  }

  // Fallback to build-time env vars
  return {
    sha: process.env.RICK_COMMIT_SHA || "unknown",
    date: process.env.RICK_COMMIT_DATE || "unknown",
  };
}

async function handleVersionCheck(res: ServerResponse): Promise<void> {
  try {
    const current = await resolveCurrentVersion();

    let latestSource: "github" | "cache" | "none" = "none";
    let latest = await fetchLatestFromGitHub();
    if (latest) {
      latestSource = "github";
      await writeLatestVersionCache(latest);
    } else {
      latest = await readLatestVersionCache();
      if (latest) {
        latestSource = "cache";
      }
    }

    // When current SHA is "unknown" (e.g. fresh install without --build-arg), we cannot
    // compare versions — but we know there IS a version available on GitHub, so treat it
    // as an update so the user can install and get proper version tracking from then on.
    const hasUpdate = latest ? (current.sha === "unknown" || latest.sha !== current.sha) : false;

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ current, latest, hasUpdate, latestSource }));
  } catch (err) {
    logger.error({ err }, "Version check failed");
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Falha ao verificar versao" }));
  }
}

// ==================== UPDATE (download GitHub zip + deploy) ====================

/**
 * Core update logic: download latest from GitHub, extract, and launch deploy.sh.
 * Used by both the HTTP /api/update endpoint and the background auto-updater.
 * Returns { success, deploying, version, versionSource, message } on success,
 * or throws on failure.
 */
async function executeUpdate(): Promise<{
  success: boolean;
  deploying: boolean;
  version: string;
  versionSource: string;
  message: string;
}> {
  const projectDir = await getProjectDir();

  logger.info("Update: downloading latest code from GitHub...");

  // Resolve target version (GitHub live first, then local cache fallback)
  let target = await fetchLatestFromGitHub();
  let versionSource: "github" | "cache" | "unknown" = "unknown";
  if (target) {
    versionSource = "github";
    await writeLatestVersionCache(target);
  } else {
    target = await readLatestVersionCache();
    if (target) versionSource = "cache";
  }

  const commitSha = target?.sha || "unknown";
  const commitDate = target?.date || "unknown";
  const zipUrl = target?.fullSha
    ? `https://github.com/${GITHUB_REPO}/archive/${target.fullSha}.zip`
    : `https://github.com/${GITHUB_REPO}/archive/refs/heads/main.zip`;

  // Download zip from GitHub
  const zipResp = await fetch(zipUrl, {
    signal: AbortSignal.timeout(30000),
  });

  if (!zipResp.ok) {
    throw new Error(`GitHub retornou ${zipResp.status}`);
  }

  const zipBuffer = Buffer.from(await zipResp.arrayBuffer());
  logger.info({ sizeMB: (zipBuffer.length / 1024 / 1024).toFixed(1) }, "Update: zip downloaded");

  // Write zip to host
  const hostStaging = `/tmp/rick-update-${Date.now()}`;
  const hostZipPath = `${hostStaging}/update.zip`;
  const hostExtractDir = `${hostStaging}/extracted`;

  await execAsyncOutput("docker", [
    "run", "--rm", "-v", "/tmp:/tmp", "alpine:latest",
    "mkdir", "-p", hostStaging,
  ]);
  await pipeToDockerFile(zipBuffer, hostZipPath);

  // Extract on host (GitHub zip is a proper zip)
  await execAsyncOutput("docker", [
    "run", "--rm", "-v", "/tmp:/tmp", "alpine:latest",
    "sh", "-c", `mkdir -p ${hostExtractDir} && cd ${hostExtractDir} && unzip -o ${hostZipPath}`,
  ]);

  // Find source root (GitHub zips have a single root dir like rick-ai-main/)
  const findRoot = await execAsyncOutput("docker", [
    "run", "--rm", "-v", "/tmp:/tmp", "alpine:latest",
    "sh", "-c", `cd ${hostExtractDir} && ls -1d */`,
  ]);
  const rootDir = findRoot.trim().replace(/\/$/, "");
  const hostSourceRoot = `${hostExtractDir}/${rootDir}`;

  // Write version stamp to staging so deploy.sh picks it up in Step 3
  await pipeToDockerFile(
    Buffer.from(`${commitSha}\n${commitDate}\n`),
    `${hostSourceRoot}/.rick-version`,
  );

  const message = `Versao ${commitSha} baixada (${(zipBuffer.length / 1024 / 1024).toFixed(1)} MB). Deploy iniciando — Rick vai reiniciar em breve.`;

  // Launch deploy.sh in a DETACHED docker:cli container.
  // This container survives Rick's restart and runs the full safe pipeline:
  //   backup → copy → build → smoke test → swap → watchdog → rollback on failure.
  setImmediate(() => {
    const deployScript = [
      `sh /deploy.sh "${hostSourceRoot}"`,
      `STATUS=$?`,
      `rm -rf "${hostStaging}"`,
      `exit $STATUS`,
    ].join("\n");

    const proc = spawn("docker", [
      "run", "-d", "--rm",
      "--name", "rick-ota-deployer",
      "-v", "/var/run/docker.sock:/var/run/docker.sock",
      "-v", `${projectDir}:${projectDir}`,
      "-v", "/tmp:/tmp",
      "-v", `${projectDir}/scripts/deploy.sh:/deploy.sh:ro`,
      "-e", `PROJECT_DIR=${projectDir}`,
      "--network", "host",
      "docker:cli",
      "sh", "-c", deployScript,
    ], { stdio: "ignore", detached: true });

    proc.unref();
    logger.info({ commitSha, hostSourceRoot }, "Update: OTA deployer launched (uses deploy.sh)");
  });

  return { success: true, deploying: true, version: commitSha, versionSource, message };
}

async function handleUpdate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const result = await executeUpdate();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  } catch (err) {
    logger.error({ err }, "Update failed");
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Erro: " + (err as Error).message }));
    }
  }
}

// ==================== AUTO-UPDATE (background) ====================

const AUTO_UPDATE_CONFIG_KEY = "AUTO_INSTALL_UPDATES";
const AUTO_UPDATE_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

let autoUpdateTimer: ReturnType<typeof setInterval> | null = null;
let autoUpdateRunning = false;

/**
 * Read the auto-install flag from the config store.
 * Defaults to true (enabled) when no value is stored.
 */
async function isAutoInstallEnabled(): Promise<boolean> {
  try {
    const val = await configGet(AUTO_UPDATE_CONFIG_KEY);
    if (val === null) return true; // default: enabled
    return val === "1" || val === "true";
  } catch {
    return true; // default on error
  }
}

/**
 * Set the auto-install flag in the config store.
 */
async function setAutoInstallEnabled(enabled: boolean): Promise<void> {
  await configSet(AUTO_UPDATE_CONFIG_KEY, enabled ? "1" : "0");
  logger.info({ enabled }, "Auto-install updates flag changed");
}

/**
 * Background auto-update check. Runs silently every 2 minutes.
 * If an update is found and auto-install is enabled, downloads and installs automatically.
 */
async function autoUpdateCheck(): Promise<void> {
  if (autoUpdateRunning) return;
  autoUpdateRunning = true;

  try {
    const enabled = await isAutoInstallEnabled();
    if (!enabled) {
      return;
    }

    const current = await resolveCurrentVersion();
    const latest = await fetchLatestFromGitHub();

    if (!latest) {
      return; // GitHub unreachable — skip silently
    }

    await writeLatestVersionCache(latest);

    const hasUpdate = current.sha === "unknown" || latest.sha !== current.sha;
    if (!hasUpdate) {
      return; // already up to date
    }

    logger.info(
      { currentSha: current.sha, latestSha: latest.sha, message: latest.message },
      "Auto-update: new version detected, starting install..."
    );

    // Notify connected web clients that an auto-update is starting
    if (registeredBroadcast) {
      registeredBroadcast({
        type: "auto_update",
        status: "installing",
        current: current,
        latest: latest,
      });
    }

    const result = await executeUpdate();
    logger.info({ version: result.version }, "Auto-update: deploy launched successfully");
  } catch (err) {
    logger.warn({ err }, "Auto-update: check/install failed (will retry next cycle)");
  } finally {
    autoUpdateRunning = false;
  }
}

/**
 * Start the background auto-update timer.
 * Called once at server startup.
 */
export function startAutoUpdateTimer(): void {
  if (autoUpdateTimer) return;

  // First check after 30 seconds (let the server finish startup)
  setTimeout(() => {
    autoUpdateCheck().catch(() => {});
  }, 30_000);

  autoUpdateTimer = setInterval(() => {
    autoUpdateCheck().catch(() => {});
  }, AUTO_UPDATE_INTERVAL_MS);

  logger.info({ intervalMs: AUTO_UPDATE_INTERVAL_MS }, "Auto-update timer started");
}

/**
 * Handle GET /api/auto-update — returns current auto-install flag.
 */
async function handleAutoUpdateGet(res: ServerResponse): Promise<void> {
  try {
    const enabled = await isAutoInstallEnabled();
    jsonResponse(res, 200, { autoInstall: enabled });
  } catch (err) {
    logger.error({ err }, "Failed to read auto-install flag");
    jsonResponse(res, 500, { error: "Falha ao ler configuracao" });
  }
}

/**
 * Handle POST /api/auto-update — sets auto-install flag.
 * Body: { "autoInstall": true|false }
 */
async function handleAutoUpdateSet(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readRequestBody(req);
    const parsed = JSON.parse(body.toString("utf-8"));
    const enabled = !!parsed.autoInstall;

    await setAutoInstallEnabled(enabled);
    jsonResponse(res, 200, { autoInstall: enabled });
  } catch (err) {
    logger.error({ err }, "Failed to set auto-install flag");
    jsonResponse(res, 500, { error: "Falha ao salvar configuracao" });
  }
}

// ==================== CODE EXPORT ====================

/** Files/dirs to include in the export zip (relative to project root) */
const EXPORT_INCLUDES = [
  "src",
  "docker",
  "scripts",
  "Dockerfile",
  "docker-compose.yml",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  ".gitignore",
  ".env.example",
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "README.md",
  "LICENSE",
  ".rick-version",

];

async function handleCodeExport(res: ServerResponse): Promise<void> {
  const projectDir = await getProjectDir();

  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `rick-ai-${timestamp}.tar.gz`;

    logger.info({ projectDir, paths: EXPORT_INCLUDES }, "Code export requested");

    // Create tar.gz from the HOST filesystem using a docker container.
    const child = spawn("docker", [
      "run", "--rm",
      "-v", `${projectDir}:${projectDir}:ro`,
      "alpine:latest",
      "tar", "czf", "-",
      "-C", projectDir,
      "--exclude=.git",
      "--exclude=node_modules",
      "--exclude=dist",
      "--exclude=.env",
      "--exclude=auth_info",
      "--exclude=data",
      "--exclude=.deploy-backup",
      "--exclude=.rick-latest-version.json",
      "--exclude=server-backup",
      "--exclude=src.bak",
      ".",
    ]);

    const chunks: Buffer[] = [];
    let errOutput = "";

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => { errOutput += chunk.toString(); });

    await new Promise<void>((resolve, reject) => {
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`tar failed (exit ${code}): ${errOutput}`));
      });
      child.on("error", reject);
    });

    const tarBuffer = Buffer.concat(chunks);

    if (tarBuffer.length === 0) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Arquivo vazio — verifique HOST_PROJECT_DIR" }));
      return;
    }

    res.writeHead(200, {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": tarBuffer.length.toString(),
    });
    res.end(tarBuffer);
    logger.info({ filename, sizeMB: (tarBuffer.length / 1024 / 1024).toFixed(1) }, "Code exported");
  } catch (err) {
    logger.error({ err }, "Code export failed");
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Falha ao exportar: " + (err as Error).message }));
    }
  }
}

// ==================== CODE IMPORT ====================

async function handleCodeImport(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const projectDir = await getProjectDir();

  try {
    // Read the entire request body
    const body = await readRequestBody(req);

    if (body.length === 0) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Corpo vazio" }));
      return;
    }

    const sizeMB = (body.length / 1024 / 1024).toFixed(1);
    logger.info({ sizeMB }, "Code import: received upload");

    // Detect format: tar.gz (gzip header 1f 8b) or zip (PK header)
    const isGzip = body[0] === 0x1f && body[1] === 0x8b;
    const isZip = body[0] === 0x50 && body[1] === 0x4b;

    if (!isGzip && !isZip) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Formato invalido. Envie um .tar.gz ou .zip" }));
      return;
    }

    const hostStaging = `/tmp/rick-import-${Date.now()}`;
    const archiveName = isZip ? "import.zip" : "import.tar.gz";
    const hostArchivePath = `${hostStaging}/${archiveName}`;
    const hostExtractDir = `${hostStaging}/extracted`;

    // Create staging dir and write archive to the HOST filesystem
    await execAsyncOutput("docker", [
      "run", "--rm",
      "-v", "/tmp:/tmp",
      "alpine:latest",
      "mkdir", "-p", hostStaging,
    ]);
    await pipeToDockerFile(body, hostArchivePath);

    // Extract archive
    const extractScript = isGzip
      ? `mkdir -p ${hostExtractDir} && tar xzf ${hostArchivePath} -C ${hostExtractDir}`
      : `mkdir -p ${hostExtractDir} && cd ${hostExtractDir} && unzip -o ${hostArchivePath}`;

    try {
      await execAsyncOutput("docker", [
        "run", "--rm",
        "-v", "/tmp:/tmp",
        "alpine:latest",
        "sh", "-c", extractScript,
      ]);
    } catch {
      // If unzip fails (not installed in alpine), try with python in our own image
      if (isZip) {
        const containerName = await getOwnContainerName();
        if (containerName) {
          await execAsyncOutput("docker", [
            "exec", containerName,
            "python3", "-c",
            `import zipfile,sys,os; os.makedirs('${hostExtractDir}',exist_ok=True); zipfile.ZipFile('${hostArchivePath}').extractall('${hostExtractDir}')`,
          ]);
        } else {
          throw new Error("Nao foi possivel extrair o zip");
        }
      } else {
        throw new Error("Falha ao extrair tar.gz");
      }
    }

    // Validate: check if src/ exists (might be nested in a single directory)
    const validateScript = [
      `cd ${hostExtractDir}`,
      `items=$(ls -1)`,
      `count=$(echo "$items" | wc -l)`,
      `if [ "$count" -eq 1 ] && [ -d "$items/src" ]; then`,
      `  echo "$items"`,
      `elif [ -d "src" ]; then`,
      `  echo "."`,
      `else`,
      `  echo "INVALID" >&2`,
      `  exit 1`,
      `fi`,
    ].join("\n");

    let sourceSubdir: string;
    try {
      sourceSubdir = (await execAsyncOutput("docker", [
        "run", "--rm",
        "-v", "/tmp:/tmp",
        "alpine:latest",
        "sh", "-c", validateScript,
      ])).trim();
    } catch {
      await cleanupHostDir(hostStaging);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Arquivo invalido: diretorio src/ nao encontrado" }));
      return;
    }

    const hostSourceRoot = sourceSubdir === "." ? hostExtractDir : `${hostExtractDir}/${sourceSubdir}`;
    logger.info({ hostSourceRoot, sizeMB }, "Code import: archive validated, launching deploy");

    // Respond immediately BEFORE launching the deployer.
    // deploy.sh restarts Rick (docker compose up -d), so no response can be sent after.
    // The client polls /health to confirm Rick is back up.
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      success: true,
      deploying: true,
      message: `Arquivo recebido (${sizeMB} MB). Deploy iniciando — Rick vai reiniciar em breve.`,
    }));

    // Launch deploy.sh in a DETACHED docker:cli container.
    // deploy.sh runs the full safe pipeline:
    //   backup → copy → build (tsc) → smoke test → swap → watchdog → rollback on failure.
    setImmediate(() => {
      const deployScript = [
        `sh /deploy.sh "${hostSourceRoot}"`,
        `STATUS=$?`,
        `rm -rf "${hostStaging}"`,
        `exit $STATUS`,
      ].join("\n");

      const proc = spawn("docker", [
        "run", "-d", "--rm",
        "--name", `rick-import-deployer-${Date.now()}`,
        "-v", "/var/run/docker.sock:/var/run/docker.sock",
        "-v", `${projectDir}:${projectDir}`,
        "-v", "/tmp:/tmp",
        "-v", `${projectDir}/scripts/deploy.sh:/deploy.sh:ro`,
        "-e", `PROJECT_DIR=${projectDir}`,
        "--network", "host",
        "docker:cli",
        "sh", "-c", deployScript,
      ], { stdio: "ignore", detached: true });

      proc.unref();
      logger.info({ hostSourceRoot }, "Import: deployer container launched (uses deploy.sh)");
    });
  } catch (err) {
    logger.error({ err }, "Code import failed");
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Erro interno: " + (err as Error).message }));
    }
  }
}

/** Pipe a buffer into a file on the HOST filesystem using docker */
async function pipeToDockerFile(data: Buffer, hostPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", [
      "run", "--rm", "-i",
      "-v", "/tmp:/tmp",
      "alpine:latest",
      "sh", "-c", `cat > ${hostPath}`,
    ], { stdio: ["pipe", "pipe", "pipe"] });

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Failed to write file to host (exit ${code}): ${stderr}`));
    });
    child.on("error", reject);
    child.stdin!.end(data);
  });
}

/** Clean up a directory on the HOST filesystem (path must be under /tmp). */
async function cleanupHostDir(hostPath: string): Promise<void> {
  await execAsyncOutput("docker", [
    "run", "--rm",
    "-v", "/tmp:/tmp",
    "alpine:latest",
    "rm", "-rf", hostPath,
  ]).catch(() => {});
}

/** Get our own container name (for docker exec) */
async function getOwnContainerName(): Promise<string | null> {
  try {
    const hostname = (await readFile("/etc/hostname", "utf-8")).trim();
    const output = await execAsyncOutput("docker", [
      "inspect", "--format", "{{.Name}}", hostname,
    ]);
    return output.trim().replace(/^\//, "");
  } catch {
    return "rick-ai-agent-1"; // fallback
  }
}

// ==================== EXEC HELPERS ====================

function execAsyncOutput(cmd: string, args: string[], opts?: { cwd?: string }, timeoutMs?: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts?.cwd });
    let output = "";
    let timer: ReturnType<typeof setTimeout> | null = null;

    if (timeoutMs) {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(`${cmd} failed (exit ${code}): ${output.slice(-1000)}`));
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
  });
}
