import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";
import { readFile, writeFile, mkdtemp, rm, readdir, stat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { logger } from "./config/logger.js";
import { query } from "./memory/database.js";
import { config } from "./config/env.js";
import { verifyAgentToken, type AgentTokenPayload } from "./subagent/agent-token.js";
import type { MemoryService } from "./memory/memory-service.js";
import type { VectorMemoryService } from "./memory/vector-memory-service.js";

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
  whatsappConnected: boolean;
  postgresConnected: boolean;
  pgvectorConnected: boolean;
  startedAt: number;
}

const state: HealthState = {
  whatsappConnected: false,
  postgresConnected: false,
  pgvectorConnected: false,
  startedAt: Date.now(),
};

export function setHealthy(key: keyof Omit<HealthState, "startedAt">, value: boolean): void {
  state[key] = value;
}

export function isHealthy(): boolean {
  return state.whatsappConnected && state.postgresConnected;
}

/** Cached HTML files (loaded once at first request) */
let cachedHtml: string | null = null;
let cachedSessionHtml: string | null = null;

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

/**
 * The shared HTTP server instance. Exported so WebConnector can
 * listen for 'upgrade' events to handle WebSocket connections.
 */
export let httpServer: Server | null = null;

// ==================== AGENT API SERVICE REGISTRY ====================
// Services are registered after init (startHealthServer runs before services are created).
let registeredMemoryService: MemoryService | null = null;
let registeredVectorMemory: VectorMemoryService | null = null;

/**
 * Register services for the sub-agent read-only API.
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

export function startHealthServer(port: number): void {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/health" && req.method === "GET") {
      const healthy = isHealthy();
      const uptimeSeconds = Math.round((Date.now() - state.startedAt) / 1000);

      const body = JSON.stringify({
        status: healthy ? "ok" : "unhealthy",
        uptime: uptimeSeconds,
        whatsapp: state.whatsappConnected,
        postgres: state.postgresConnected,
        pgvector: state.pgvectorConnected,
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

    // Media blob endpoint: /audio/:id or /img/:id (both use audio_blobs table)
    const mediaMatch = req.url?.match(/^\/(audio|img)\/([a-f0-9]{16})$/);
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
        res.writeHead(200, {
          "Content-Type": mime_type,
          "Content-Length": Buffer.byteLength(data),
          "Cache-Control": "public, max-age=31536000, immutable",
        });
        res.end(data);
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

    // ==================== AGENT READ-ONLY API (JWT-authenticated) ====================
    // Endpoints for sub-agents (edit sessions, ephemeral sub-agents) to query
    // memories, credentials, config, conversations, and semantic search.
    // Authentication uses Bearer JWT tokens, NOT the web UI password.

    if (req.url?.startsWith("/api/agent/") && req.method === "GET") {
      const agentSession = authenticateAgentRequest(req, res);
      if (!agentSession) return;
      await handleAgentApi(req, res, agentSession);
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
 * Route handler for all /api/agent/* endpoints.
 * All endpoints are read-only and scoped to the token's userPhone.
 */
async function handleAgentApi(
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
      const memories = await registeredMemoryService.listMemories(session.userPhone, category);
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
      const memories = await registeredMemoryService.listMemories(session.userPhone, category);
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

    // GET /api/agent/search?q=texto&limit=5 — Semantic vector search
    if (path === "/api/agent/search") {
      if (!registeredVectorMemory) {
        jsonResponse(res, 503, { error: "Busca semantica nao disponivel (pgvector nao configurado)" });
        return;
      }
      const q = url.searchParams.get("q") || "";
      if (!q) {
        jsonResponse(res, 400, { error: "Parametro 'q' e obrigatorio" });
        return;
      }
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "5"), 20);
      const results = await registeredVectorMemory.search(session.userPhone, q, limit);
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
    }

    // GET /api/agent/conversations?limit=20 — Recent conversation history
    if (path === "/api/agent/conversations") {
      if (!registeredMemoryService) {
        jsonResponse(res, 503, { error: "MemoryService nao disponivel" });
        return;
      }
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "20"), 100);
      const messages = await registeredMemoryService.getConversationHistory(session.userPhone, limit);
      logger.info(
        { sessionId: session.sessionId, limit, count: messages.length },
        "Agent API: conversations requested",
      );
      jsonResponse(res, 200, { messages });
      return;
    }

    // Unknown /api/agent/* path
    jsonResponse(res, 404, { error: "Endpoint nao encontrado" });
  } catch (err) {
    logger.error({ err, path, sessionId: session.sessionId }, "Agent API request failed");
    jsonResponse(res, 500, { error: "Erro interno" });
  }
}

/** Helper to send JSON responses. */
function jsonResponse(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
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

function getProjectDir(): string {
  return process.env.HOST_PROJECT_DIR || "/home/ubuntu/rick-ai";
}

function getVersionCachePath(): string {
  // Write cache inside the container's own app dir (/app), not HOST_PROJECT_DIR
  // which points to the host filesystem and is inaccessible from inside the container.
  const appDir = process.cwd();
  return join(appDir, VERSION_CACHE_FILE);
}

async function fetchLatestFromGitHub(): Promise<LatestVersionInfo | null> {
  try {
    const resp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/commits/main`, {
      headers: { "Accept": "application/vnd.github.v3+json", "User-Agent": "RickAI" },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) {
      logger.warn({ status: resp.status }, "Version check: GitHub API returned non-OK");
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
 * Resolve current version from env vars (set at build time) or .rick-version file (fallback).
 * The .rick-version file is written by the OTA updater and also COPYed into the image
 * from the build context, so it works even when docker compose up --build is run
 * without explicit --build-arg COMMIT_SHA=... (e.g. after /publish or manual rebuild).
 */
async function resolveCurrentVersion(): Promise<{ sha: string; date: string }> {
  let sha = process.env.RICK_COMMIT_SHA || "unknown";
  let date = process.env.RICK_COMMIT_DATE || "unknown";

  if (sha === "unknown") {
    try {
      const content = await readFile(".rick-version", "utf-8");
      const lines = content.trim().split("\n");
      if (lines[0] && lines[0] !== "unknown") sha = lines[0].trim();
      if (lines[1] && lines[1] !== "unknown") date = lines[1].trim();
    } catch {
      // .rick-version not found — stay "unknown"
    }
  }

  return { sha, date };
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

    const hasUpdate = latest ? (current.sha !== "unknown" && latest.sha !== current.sha) : false;

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ current, latest, hasUpdate, latestSource }));
  } catch (err) {
    logger.error({ err }, "Version check failed");
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Falha ao verificar versao" }));
  }
}

// ==================== UPDATE (download GitHub zip + deploy) ====================

async function handleUpdate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const projectDir = getProjectDir();

  try {
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
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `GitHub retornou ${zipResp.status}` }));
      return;
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

    // Write version stamp so deploy.sh / docker-compose can pick it up
    await pipeToDockerFile(
      Buffer.from(`${commitSha}\n${commitDate}\n`),
      `${hostSourceRoot}/.rick-version`,
    );

    const deployLog: string[] = [];
    deployLog.push(`[update] Downloaded from GitHub (${(zipBuffer.length / 1024 / 1024).toFixed(1)} MB)`);
    deployLog.push(`[update] Version: ${commitSha} (${commitDate})`);
    deployLog.push(`[update] Version source: ${versionSource}`);

    // Backup + copy
    const copyScript = [
      `set -e`,
      `rm -rf ${projectDir}/src.bak`,
      `cp -r ${projectDir}/src ${projectDir}/src.bak`,
      `cd ${hostSourceRoot}`,
      `for d in src docker scripts; do`,
      `  if [ -d "$d" ]; then rm -rf ${projectDir}/$d && cp -r $d ${projectDir}/$d; fi`,
      `done`,
      `for f in Dockerfile docker-compose.yml package.json package-lock.json tsconfig.json .gitignore .env.example AGENTS.md CLAUDE.md GEMINI.md README.md LICENSE deploy-db.sh setup-oracle.sh .rick-version; do`,
      `  if [ -f "$f" ]; then cp "$f" ${projectDir}/$f; fi`,
      `done`,
      `echo "done"`,
    ].join("\n");

    await execAsyncOutput("docker", [
      "run", "--rm",
      "-v", `${projectDir}:${projectDir}`,
      "-v", "/tmp:/tmp",
      "alpine:latest",
      "sh", "-c", copyScript,
    ]);
    deployLog.push("[update] Files copied");

    // Respond immediately BEFORE rebuilding.
    // The rebuild restarts this container, so we can never send a response after.
    // The client handles the disconnection and polls /health to confirm.
    deployLog.push("[update] Starting build via external deployer...");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      success: true,
      deploying: true,
      version: commitSha,
      versionSource,
      log: deployLog.join("\n"),
      message: "Arquivos copiados. Build iniciando — Rick vai reiniciar em breve.",
    }));

    // Launch build+restart in a DETACHED docker:cli container.
    // This container survives Rick's own restart (it runs independently on the host Docker).
    // The script: build → smoke test → swap → watchdog → rollback on failure.
    // Same safety guarantees as deploy.sh but triggered from OTA update.
    setImmediate(() => {
      const deployScript = [
        `set -e`,
        `echo "[ota-deploy] Building candidate image..."`,
        `cd ${projectDir}`,
        `docker build --build-arg COMMIT_SHA=${commitSha} --build-arg COMMIT_DATE=${commitDate} -t rick-ai-agent:candidate -f Dockerfile . || {`,
        `  echo "[ota-deploy] Build FAILED — rolling back src/"`,
        `  rm -rf ${projectDir}/src && cp -r ${projectDir}/src.bak ${projectDir}/src`,
        `  rm -rf ${projectDir}/src.bak ${hostStaging}`,
        `  exit 1`,
        `}`,
        ``,
        `echo "[ota-deploy] Smoke testing candidate (HEALTH_ONLY)..."`,
        `docker rm -f rick-ota-candidate 2>/dev/null || true`,
        `docker run -d --name rick-ota-candidate --env-file ${projectDir}/.env -e HEALTH_ONLY=true -p 8081:80 rick-ai-agent:candidate`,
        `HEALTHY=false`,
        `for i in $(seq 1 20); do`,
        `  sleep 3`,
        `  RESP=$(wget -qO- http://localhost:8081/health 2>/dev/null || echo "")`,
        `  if echo "$RESP" | grep -q '"status":"ok"'; then`,
        `    HEALTHY=true`,
        `    echo "[ota-deploy] Candidate healthy after attempt $i"`,
        `    break`,
        `  fi`,
        `  echo "[ota-deploy] Health check $i/20: $RESP"`,
        `done`,
        `docker rm -f rick-ota-candidate 2>/dev/null || true`,
        ``,
        `if [ "$HEALTHY" != "true" ]; then`,
        `  echo "[ota-deploy] Smoke test FAILED — rolling back"`,
        `  rm -rf ${projectDir}/src && cp -r ${projectDir}/src.bak ${projectDir}/src`,
        `  rm -rf ${projectDir}/src.bak ${hostStaging}`,
        `  docker rmi rick-ai-agent:candidate 2>/dev/null || true`,
        `  exit 2`,
        `fi`,
        ``,
        `echo "[ota-deploy] Swapping: promoting candidate..."`,
        `docker tag rick-ai-agent:candidate rick-ai-agent:latest`,
        `docker compose -f ${projectDir}/docker-compose.yml up -d`,
        `docker rmi rick-ai-agent:candidate 2>/dev/null || true`,
        ``,
        `echo "[ota-deploy] Watchdog: monitoring for 60s..."`,
        `WATCH_OK=true`,
        `for i in $(seq 1 12); do`,
        `  sleep 5`,
        `  RESP=$(wget -qO- http://localhost:80/health 2>/dev/null || echo "")`,
        `  if echo "$RESP" | grep -q '"status":"ok"'; then`,
        `    echo "[ota-deploy] Watchdog $i/12: healthy"`,
        `  else`,
        `    echo "[ota-deploy] Watchdog $i/12 FAILED: $RESP"`,
        `    WATCH_OK=false`,
        `    break`,
        `  fi`,
        `done`,
        ``,
        `if [ "$WATCH_OK" != "true" ]; then`,
        `  echo "[ota-deploy] Watchdog FAILED — rolling back!"`,
        `  rm -rf ${projectDir}/src && cp -r ${projectDir}/src.bak ${projectDir}/src`,
        `  rm -rf ${projectDir}/src.bak`,
        `  docker compose -f ${projectDir}/docker-compose.yml up -d --build`,
        `  rm -rf ${hostStaging}`,
        `  exit 3`,
        `fi`,
        ``,
        `echo "[ota-deploy] Success! Cleaning up..."`,
        `rm -rf ${projectDir}/src.bak ${hostStaging}`,
        `echo "[ota-deploy] Done."`,
      ].join("\n");

      const proc = spawn("docker", [
        "run", "-d", "--rm",
        "--name", "rick-ota-deployer",
        "-v", "/var/run/docker.sock:/var/run/docker.sock",
        "-v", `${projectDir}:${projectDir}`,
        "-v", "/tmp:/tmp",
        "--network", "host",
        "-w", projectDir,
        "docker:cli",
        "sh", "-c", deployScript,
      ], { stdio: "ignore", detached: true });

      proc.unref();
      logger.info("Update: OTA deployer container launched (detached)");
    });
  } catch (err) {
    logger.error({ err }, "Update failed");
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Erro: " + (err as Error).message }));
    }
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
  "deploy-db.sh",
  "setup-oracle.sh",
];

async function handleCodeExport(res: ServerResponse): Promise<void> {
  const projectDir = process.env.HOST_PROJECT_DIR || "/home/ubuntu/rick-ai";

  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `rick-ai-${timestamp}.tar.gz`;

    logger.info({ projectDir, paths: EXPORT_INCLUDES }, "Code export requested");

    // Create tar.gz from the HOST filesystem using a docker container.
    // The container itself doesn't have the host project dir mounted,
    // but it has docker.sock so we can run a helper container that does.
    const tarArgs: string[] = [];
    for (const item of EXPORT_INCLUDES) {
      tarArgs.push("--exclude=node_modules");
      tarArgs.push("--exclude=dist");
    }

    const child = spawn("docker", [
      "run", "--rm",
      "-v", `${projectDir}:${projectDir}:ro`,
      "alpine:latest",
      "tar", "czf", "-",
      "-C", projectDir,
      "--exclude=node_modules",
      "--exclude=dist",
      "--exclude=.env",
      "--exclude=auth_info",
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
  const projectDir = process.env.HOST_PROJECT_DIR || "/home/ubuntu/rick-ai";

  try {
    // Read the entire request body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks);

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

    // Strategy:
    // 1. Write archive to a HOST-accessible path using docker cp or piping through a container
    // 2. Extract on host, validate, copy to project dir
    // 3. docker compose up -d --build
    //
    // Since /tmp is NOT shared between container and host, we use docker to
    // write data to the host filesystem. We pipe the archive via stdin to an
    // alpine container that has the host project dir mounted.

    const deployLog: string[] = [];
    const hostStaging = `/tmp/rick-import-${Date.now()}`;

    // Step 1: Create staging dir on host and write archive there
    deployLog.push("[import] Criando staging dir no host...");
    await execAsyncOutput("docker", [
      "run", "--rm",
      "-v", "/tmp:/tmp",
      "alpine:latest",
      "mkdir", "-p", hostStaging,
    ]);

    // Write archive to host via stdin pipe to a docker container
    const archiveName = isZip ? "import.zip" : "import.tar.gz";
    const hostArchivePath = `${hostStaging}/${archiveName}`;
    const hostExtractDir = `${hostStaging}/extracted`;

    await pipeToDockerFile(body, hostArchivePath);
    deployLog.push(`[import] Arquivo salvo no host (${sizeMB} MB)`);

    // Step 2: Extract and validate on host
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
    deployLog.push("[import] Arquivo extraido");

    // Validate: check if src/ exists (might be nested in a single directory)
    const validateScript = [
      `cd ${hostExtractDir}`,
      // If single dir containing src/, use it as root
      `items=$(ls -1)`,
      `count=$(echo "$items" | wc -l)`,
      `if [ "$count" -eq 1 ] && [ -d "$items/src" ]; then`,
      `  echo "$items"`,  // print the nested dir name
      `elif [ -d "src" ]; then`,
      `  echo "."`,       // root is extract dir itself
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
    deployLog.push(`[import] Source root: ${hostSourceRoot}`);

    // Step 3: Backup current src/ on host and copy new files
    const copyScript = [
      `set -e`,
      `echo "[import] Backing up src/"`,
      `rm -rf ${projectDir}/src.bak`,
      `cp -r ${projectDir}/src ${projectDir}/src.bak`,
      `echo "[import] Copying files..."`,
      `cd ${hostSourceRoot}`,
      // Copy directories
      `for d in src docker scripts; do`,
      `  if [ -d "$d" ]; then`,
      `    rm -rf ${projectDir}/$d`,
      `    cp -r $d ${projectDir}/$d`,
      `    echo "[import] Copied: $d/"`,
      `  fi`,
      `done`,
      // Copy individual files
      `for f in Dockerfile docker-compose.yml package.json package-lock.json tsconfig.json .gitignore .env.example AGENTS.md CLAUDE.md GEMINI.md README.md LICENSE .rick-version deploy-db.sh setup-oracle.sh; do`,
      `  if [ -f "$f" ]; then`,
      `    cp "$f" ${projectDir}/$f`,
      `    echo "[import] Copied: $f"`,
      `  fi`,
      `done`,
      `echo "[import] Done"`,
    ].join("\n");

    try {
      const copyOutput = await execAsyncOutput("docker", [
        "run", "--rm",
        "-v", `${projectDir}:${projectDir}`,
        "-v", "/tmp:/tmp",
        "alpine:latest",
        "sh", "-c", copyScript,
      ]);
      deployLog.push(copyOutput.trim());
    } catch (copyErr) {
      await cleanupHostDir(hostStaging);
      deployLog.push("[import] FAILED: " + (copyErr as Error).message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Falha ao copiar arquivos", log: deployLog.join("\n") }));
      return;
    }

    // Step 4: Read version from .rick-version if present, then build
    let importSha = "unknown";
    let importDate = "unknown";
    try {
      const versionContent = await execAsyncOutput("docker", [
        "run", "--rm", "-v", `${projectDir}:${projectDir}:ro`, "alpine:latest",
        "cat", `${projectDir}/.rick-version`,
      ]);
      const lines = versionContent.trim().split("\n");
      if (lines[0]) importSha = lines[0];
      if (lines[1]) importDate = lines[1];
    } catch { /* no .rick-version, keep defaults */ }

    deployLog.push("[import] Building (tsc + Docker)...");

    try {
      const buildOutput = await execAsyncOutput("docker", [
        "run", "--rm",
        "-v", "/var/run/docker.sock:/var/run/docker.sock",
        "-v", `${projectDir}:${projectDir}`,
        "-w", projectDir,
        "-e", `RICK_COMMIT_SHA=${importSha}`,
        "-e", `RICK_COMMIT_DATE=${importDate}`,
        "docker:cli",
        "docker", "compose", "up", "-d", "--build",
      ], undefined, 300000);  // 5 min timeout for build
      const lastLines = buildOutput.trim().split("\n").slice(-8).join("\n");
      deployLog.push(lastLines);
      deployLog.push("[import] Deploy successful!");

      // Clean up staging and backup on host
      await cleanupHostDir(hostStaging);
      await cleanupHostDir(`${projectDir}/src.bak`);

      // Send response before this container gets replaced
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, log: deployLog.join("\n") }));
    } catch (buildErr) {
      // Build failed — rollback
      deployLog.push("[import] Build FAILED: " + (buildErr as Error).message);
      deployLog.push("[import] Rolling back...");

      try {
        await execAsyncOutput("docker", [
          "run", "--rm",
          "-v", `${projectDir}:${projectDir}`,
          "alpine:latest",
          "sh", "-c",
          `rm -rf ${projectDir}/src && cp -r ${projectDir}/src.bak ${projectDir}/src && rm -rf ${projectDir}/src.bak`,
        ]);
        deployLog.push("[import] Rollback complete");
      } catch (rbErr) {
        deployLog.push("[import] Rollback FAILED: " + (rbErr as Error).message);
      }

      await cleanupHostDir(hostStaging);
      logger.error({ err: buildErr }, "Code import: build failed, rolled back");

      res.writeHead(422, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: "Build falhou (rollback automatico aplicado)",
        log: deployLog.join("\n"),
      }));
    }
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

/** Clean up a directory on the HOST filesystem */
async function cleanupHostDir(hostPath: string): Promise<void> {
  await execAsyncOutput("docker", [
    "run", "--rm",
    "-v", "/tmp:/tmp",
    "-v", `${hostPath}:${hostPath}`,
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

function execAsync(cmd: string, args: string[], opts?: { cwd?: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts?.cwd });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} failed (exit ${code}): ${stderr.slice(-500)}`));
    });
    child.on("error", reject);
  });
}

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
