import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectorManager } from "../connectors/connector-manager.js";
import { logger } from "../config/logger.js";
import { config } from "../config/env.js";
import { createAgentToken } from "./agent-token.js";
import type { MemoryService } from "../memory/memory-service.js";
import type { MediaAttachment } from "../llm/types.js";

const execFileAsync = promisify(execFile);

/**
 * Write a prompt to a temporary file on the HOST, docker-cp it into the container,
 * then delete the host file. Returns the path inside the container.
 *
 * This eliminates all shell injection risks — the prompt never passes through sh -c.
 */
async function writePromptToContainer(
  containerName: string,
  prompt: string
): Promise<string> {
  const tmpFile = join(tmpdir(), `prompt-${randomBytes(8).toString("hex")}.txt`);
  const containerPath = `/tmp/prompt-${randomBytes(8).toString("hex")}.txt`;

  await writeFile(tmpFile, prompt, "utf-8");
  try {
    await execFileAsync("docker", ["cp", tmpFile, `${containerName}:${containerPath}`]);
  } finally {
    await unlink(tmpFile).catch(() => {});
  }
  return containerPath;
}

/** Called when Claude Code returns a 401 auth error. Returns true if token was refreshed. */
export type AuthExpiredCallback = () => Promise<boolean>;
/** Called before each Claude invocation to get a fresh token. Returns {accessToken, refreshToken?} or null. */
export type GetFreshTokenCallback = () => Promise<{ accessToken: string; refreshToken?: string } | null>;
/** Called when Claude hits rate limit in edit mode. Should use GPT Codex to complete the task. */
export type GptFallbackCallback = (prompt: string) => Promise<string>;
/** Called to persist assistant messages in the conversation history with their type. */
export type SaveHistoryFn = (text: string, type: "text" | "tool_use") => Promise<void>;
/** Called when the edit session closes (deploy success or /exit) so the caller can clean up references. */
export type OnCloseCallback = () => void;

/** Internal callback type for sending messages (derived from ConnectorManager). */
type SendFn = (text: string, messageType?: "text" | "tool_use") => Promise<void>;
/** Internal callback type for typing indicator (derived from ConnectorManager). */
type TypingFn = (composing: boolean) => Promise<void>;

type EditState = "starting" | "ready" | "running" | "deploying" | "auth_expired" | "closed";

/**
 * Serialized message queue for streaming output.
 *
 * Each push() immediately enqueues a send — sem debounce, sem buffer de espera.
 * A serialização via Promise chain garante que as mensagens chegam em ordem
 * e sem race conditions (todos os envios passam por uma única cadeia de Promises).
 * Textos maiores que maxChars são quebrados em chunks menores.
 */
class StreamQueue {
  private sendChain: Promise<void> = Promise.resolve();
  private sendFn: SendFn;
  private maxChars: number;

  constructor(sendFn: SendFn, maxChars = 3500) {
    this.sendFn = sendFn;
    this.maxChars = maxChars;
  }

  /** Envia o texto imediatamente (serializado via Promise chain). Divide em chunks se necessário. */
  push(text: string, messageType?: "text" | "tool_use"): void {
    const trimmed = text.trim();
    if (!trimmed) return;

    const chunks = this.splitChunks(trimmed);
    for (const chunk of chunks) {
      this.sendChain = this.sendChain
        .then(() => this.sendFn(chunk, messageType))
        .catch((err) => {
          logger.warn({ err }, "StreamQueue: failed to send chunk");
        });
    }
  }

  /** Aguarda todos os envios enfileirados completarem. Chame no fechamento. */
  async drain(): Promise<void> {
    await this.sendChain;
  }

  private splitChunks(text: string): string[] {
    if (text.length <= this.maxChars) return [text];

    const chunks: string[] = [];
    let chunk = "";
    for (const line of text.split("\n")) {
      if (chunk.length + line.length + 1 > this.maxChars) {
        if (chunk.trim()) chunks.push(chunk.trim());
        chunk = line + "\n";
      } else {
        chunk += line + "\n";
      }
    }
    if (chunk.trim()) chunks.push(chunk.trim());
    return chunks;
  }
}

/**
 * Interactive edit session for modifying Rick's own source code.
 *
 * - Spins up a Claude Code container with a COPY of Rick's src/ mounted
 * - User messages go directly to Claude Code as prompts
 * - Claude Code output streams back to user via the originating connector
 * - /deploy triggers the safe deploy pipeline
 * - /exit kills the session and discards changes
 *
 * Output is routed back to the user via ConnectorManager using the
 * connectorName and userId provided at construction time.
 */
const EDIT_SYSTEM_PROMPT = [
  "Voce e um agente de edicao do Rick AI, um agente pessoal de IA.",
  "O workspace /workspace contem o codigo do projeto (src/, Dockerfile, docker-compose.yml, package.json, tsconfig.json, README.md).",
  "O projeto usa Node.js 22, TypeScript, e roda em Docker.",
  "Sempre responda em portugues brasileiro (pt-BR).",
  "Use npx tsc --noEmit para verificar erros de TypeScript antes de concluir.",
  "Nao modifique AGENTS.md, CLAUDE.md ou GEMINI.md a menos que seja explicitamente pedido.",
  "",
  "CREDENCIAIS E DADOS DO RICK:",
  "Voce tem acesso a uma API read-only do Rick principal para consultar memorias, credenciais, conversas e busca semantica.",
  "Use as variaveis de ambiente $RICK_API_URL e $RICK_SESSION_TOKEN para autenticar.",
  "Endpoints disponiveis:",
  "- GET $RICK_API_URL/api/agent/config (config operacional)",
  "- GET $RICK_API_URL/api/agent/memories?category=<cat> (listar memorias; categorias comuns: credenciais, senhas, tokens, geral, pessoal, notas, preferencias)",
  "- GET $RICK_API_URL/api/agent/memory?category=<cat>&key=<key> (buscar memoria especifica)",
  "- GET $RICK_API_URL/api/agent/search?q=<texto>&limit=5 (busca semantica)",
  "- GET $RICK_API_URL/api/agent/conversations?limit=20 (historico de conversas)",
  "Todas as requisicoes exigem header: Authorization: Bearer $RICK_SESSION_TOKEN",
  "Exemplo: curl -sf -H \"Authorization: Bearer $RICK_SESSION_TOKEN\" \"$RICK_API_URL/api/agent/memories?category=credenciais\"",
].join("\n");

export class EditSession {
  readonly id: string;
  readonly containerName: string;
  readonly stagingDir: string;
  /** Which connector originated this edit session (for routing output back) */
  readonly connectorName: string;
  /** Canonical user ID (for routing output back) */
  readonly userId: string;
  private state: EditState = "starting";
  private containerId: string | null = null;
  private sendMessage: SendFn;
  private setTyping: TypingFn | null;
  private onAuthExpired: AuthExpiredCallback | null;
  private getFreshToken: GetFreshTokenCallback | null;
  private gptFallback: GptFallbackCallback | null;
  private saveHistory: SaveHistoryFn | null;
  private onClose: OnCloseCallback | null;
  private memoryService: MemoryService | null;
  private typingInterval: ReturnType<typeof setInterval> | null = null;
  /** The last prompt that failed due to auth — retried only if no output was produced */
  private lastFailedPrompt: { text: string; medias?: MediaAttachment[]; isContinue: boolean; hadOutput: boolean } | null = null;

  constructor(
    connectorManager: ConnectorManager,
    connectorName: string,
    userId: string,
    onAuthExpired?: AuthExpiredCallback,
    getFreshToken?: GetFreshTokenCallback,
    gptFallback?: GptFallbackCallback,
    saveHistory?: SaveHistoryFn,
    onClose?: OnCloseCallback,
    memoryService?: MemoryService,
  ) {
    this.id = randomBytes(8).toString("hex");
    this.containerName = `edit-session-${this.id}`;
    this.stagingDir = `/tmp/rick-edit-${this.id}`;
    this.connectorName = connectorName;
    this.userId = userId;

    // Derive send/typing functions from ConnectorManager
    this.sendMessage = async (text: string, messageType?: "text" | "tool_use") => {
      await connectorManager.sendMessage(connectorName, userId, text, { messageType });
    };
    this.setTyping = connectorManager.get(connectorName)?.capabilities.typing
      ? async (composing: boolean) => {
          await connectorManager.setTyping(connectorName, userId, composing);
        }
      : null;

    this.onAuthExpired = onAuthExpired ?? null;
    this.getFreshToken = getFreshToken ?? null;
    this.gptFallback = gptFallback ?? null;
    this.saveHistory = saveHistory ?? null;
    this.onClose = onClose ?? null;
    this.memoryService = memoryService ?? null;
  }

  /**
   * Re-inject fresh OAuth credentials into the running container.
   * Called after token refresh or re-auth completes.
   */
  async refreshCredentials(accessToken: string, refreshToken?: string): Promise<void> {
    if (!this.containerId || this.state === "closed") return;

    const credsJson = JSON.stringify({
      claudeAiOauth: {
        accessToken,
        refreshToken: refreshToken || "",
        expiresAt: Date.now() + 3600 * 1000,
        scopes: ["user:inference"],
      },
    });

    await execFileAsync("docker", [
      "exec", this.containerName,
      "sh", "-c",
      `echo '${credsJson.replace(/'/g, "'\\''")}' > /home/claude/.claude/.credentials.json`,
    ]);

    logger.info({ sessionId: this.id }, "Edit session credentials refreshed");

    // If we were in auth_expired, go back to ready
    if (this.state === "auth_expired") {
      this.state = "ready";

      if (this.lastFailedPrompt) {
        if (this.lastFailedPrompt.hadOutput) {
          // Claude had already produced output before the 401 — don't auto-retry
          // (would cause duplicate/confusing output). Let user re-send.
          await this.sendMessage(
            "_Token renovado! O Claude ja tinha respondido parcialmente antes do erro._\n" +
            "_Mande seu comando novamente quando quiser continuar._"
          );
          this.lastFailedPrompt = null;
        } else {
          // No output was produced — safe to auto-retry
          const { text, medias, isContinue } = this.lastFailedPrompt;
          this.lastFailedPrompt = null;
          await this.sendMessage("_Token renovado! Retomando o comando..._");
          if (isContinue) {
            await this.sendContinue(text, medias);
          } else {
            await this.sendPrompt(text, medias);
          }
        }
      }
    }
  }

  /**
   * Start showing "typing..." indicator.
   * Some connectors (WhatsApp) auto-cancel composing after ~25s, so we refresh every 20s.
   */
  private startTyping(): void {
    this.setTyping?.(true).catch(() => {});
    this.typingInterval = setInterval(() => {
      this.setTyping?.(true).catch(() => {});
    }, 20_000);
  }

  /**
   * Stop "typing..." indicator and clear the refresh interval.
   */
  private stopTyping(): void {
    if (this.typingInterval) {
      clearInterval(this.typingInterval);
      this.typingInterval = null;
    }
    this.setTyping?.(false).catch(() => {});
  }

  getState(): EditState {
    return this.state;
  }

  /**
   * Start the edit session:
   * 1. Create staging dir with copy of src/
   * 2. Spin up Claude Code container with staging dir mounted
   */
  async start(env: Record<string, string>): Promise<void> {
    const projectDir = process.env.HOST_PROJECT_DIR || "/home/ubuntu/rick-ai";

    // Create staging directory with copy of current source on the HOST.
    // We copy src/, package.json, tsconfig.json, package-lock.json from the host project,
    // then run `npm install` to get ALL dependencies including devDependencies (typescript).
    // This lets Claude Code run `npx tsc --noEmit` to check for errors.
    //
    // Note: The Rick production image runs `npm prune --production` so its node_modules
    // lacks typescript. We must do a full install here. The package-lock.json makes it fast.
    await execFileAsync("docker", [
      "run", "--rm",
      "-v", `${projectDir}:/source:ro`,
      "-v", `/tmp:/tmp`,
      "node:22-slim",
      "sh", "-c",
      [
        `mkdir -p ${this.stagingDir}`,
        `cp -r /source/src /source/package.json /source/tsconfig.json ${this.stagingDir}/`,
        `cp /source/package-lock.json ${this.stagingDir}/ 2>/dev/null || true`,
        `cp /source/*.md ${this.stagingDir}/ 2>/dev/null || true`,
        `cp /source/Dockerfile /source/docker-compose.yml ${this.stagingDir}/ 2>/dev/null || true`,
        `cd ${this.stagingDir} && npm install --prefer-offline 2>/dev/null`,
        `chown -R 1001:1001 ${this.stagingDir}`,
      ].join(" && "),
    ], { timeout: 120_000 });

    logger.info({ stagingDir: this.stagingDir, sessionId: this.id }, "Staging directory created");

    // === Agent API: generate JWT and resolve upfront credentials ===
    const agentApiEnv = await this.buildAgentApiEnv();

    // Build env args (caller env + agent API env)
    const mergedEnv = { ...env, ...agentApiEnv };
    const envArgs: string[] = [];
    for (const [key, value] of Object.entries(mergedEnv)) {
      envArgs.push("-e", `${key}=${value}`);
    }

    // Start Claude Code container with staging dir mounted as workspace
    const { stdout: containerId } = await execFileAsync("docker", [
      "run", "-d",
      "--init",
      "--ipc=host",
      "--add-host=host.docker.internal:host-gateway",
      "--name", this.containerName,
      ...envArgs,
      "-e", "DISABLE_AUTOUPDATE=1",
      "-e", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
      "-e", "PLAYWRIGHT_BROWSERS_PATH=/ms-playwright",
      "-v", `${this.stagingDir}:/workspace`,
      "subagent-claude",
      "sleep", "7200", // 2 hours for edit sessions
    ]);

    this.containerId = containerId.trim();
    this.state = "ready";

    // Write credentials if available
    if (env.CLAUDE_CODE_OAUTH_TOKEN) {
      const credsJson = JSON.stringify({
        claudeAiOauth: {
          accessToken: env.CLAUDE_CODE_OAUTH_TOKEN,
          refreshToken: env.CLAUDE_REFRESH_TOKEN || "",
          expiresAt: Date.now() + 3600 * 1000,
          scopes: ["user:inference"],
        },
      });
      await execFileAsync("docker", [
        "exec", this.containerName,
        "sh", "-c",
        `echo '${credsJson.replace(/'/g, "'\\''")}' > /home/claude/.claude/.credentials.json`,
      ]);
    }

    logger.info(
      { sessionId: this.id, containerId: this.containerId, container: this.containerName },
      "Edit session container started"
    );

    await this.sendMessage(
      `*Modo de edicao ativado!*\n\n` +
      `O Claude Code tem acesso ao codigo-fonte do Rick.\n` +
      `Mande suas instrucoes diretamente — tudo vai pro Claude Code.\n\n` +
      `Comandos:\n` +
      `- */deploy* — aplica as mudancas (com verificacao de seguranca)\n` +
      `- */exit* — descarta tudo e sai do modo de edicao`
    );
  }

  /**
   * Run a Claude Code command and STREAM output to WhatsApp in real-time.
   *
   * Uses StreamQueue para serializar envios sem debounce:
   * - Eventos NDJSON são parseados conforme chegam do stdout
   * - Cada bloco de texto ou tool_use é enviado imediatamente como mensagem separada
   * - A serialização via Promise chain garante ordem e evita race conditions
   * - On close, drain() aguarda todos os envios pendentes completarem
   *
   * @param args - Array of arguments to pass directly to docker exec (no shell).
   *               Uses -w /workspace to set working directory safely.
   */
  private async runClaude(args: string[]): Promise<void> {
    this.startTyping();

    const isRateLimitSignal = (text: string): boolean => {
      const lower = text.toLowerCase();
      return (
        lower.includes("rate limit") ||
        lower.includes("429") ||
        lower.includes("overloaded") ||
        lower.includes("credits") ||
        lower.includes("quota") ||
        lower.includes("hit your limit") ||
        (lower.includes("limit") && lower.includes("resets"))
      );
    };

    return new Promise<void>((resolve) => {
      // Use -w to set working directory inside the container.
      // No sh -c — args are passed directly via execve, preventing shell injection.
      const child = spawn("docker", [
        "exec", "-w", "/workspace", this.containerName,
        ...args,
      ]);

      const queue = new StreamQueue(this.sendMessage, 3500);
      let ndjsonBuffer = "";
      let totalOutput = 0;
      let authFailed = false;
      let rateLimited = false;

      child.stdout?.on("data", (chunk: Buffer) => {
        ndjsonBuffer += chunk.toString();
        const lines = ndjsonBuffer.split("\n");
        ndjsonBuffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let evt: any;
          try {
            evt = JSON.parse(trimmed);
          } catch {
            // Not JSON — raw stderr/verbose output.
            // Only detect auth errors in non-JSON lines (actual CLI stderr),
            // never in Claude Code's text responses (which are JSON).
            if (
              trimmed.includes("OAuth token has expired") ||
              (trimmed.includes("Failed to authenticate") && trimmed.includes("API Error: 401"))
            ) {
              authFailed = true;
            }
            // Detect rate limit / credits exhaustion
            if (isRateLimitSignal(trimmed)) {
              rateLimited = true;
            }
            continue;
          }

          // Detect auth errors in JSON error/system events only
          // (never in "assistant" type — those contain Claude's text which may mention auth concepts)
          if (
            evt.type === "error" &&
            typeof evt.error?.type === "string" &&
            evt.error.type === "authentication_error"
          ) {
            authFailed = true;
          }
          if (
            evt.type === "system" &&
            typeof evt.error === "string" &&
            evt.error.includes("authentication")
          ) {
            authFailed = true;
          }

          // Detect rate limit in JSON error events
          if (evt.type === "error") {
            const errMsg = typeof evt.error === "string" ? evt.error : evt.error?.message || "";
            if (isRateLimitSignal(errMsg)) {
              rateLimited = true;
            }
          }

          if (evt.type === "assistant") {
            for (const block of evt.message?.content ?? []) {
              if (block.type === "text") {
                queue.push(block.text, "text");
                totalOutput += block.text.length;
                this.saveHistory?.(block.text, "text").catch(() => {});
                if (isRateLimitSignal(block.text)) {
                  rateLimited = true;
                }
              } else if (block.type === "tool_use") {
                let toolLine = `\n\`[${block.name}]\` `;
                if (block.input?.command) {
                  toolLine += `\`$ ${block.input.command}\`\n`;
                } else if (block.input?.filePath || block.input?.file_path) {
                  toolLine += `\`${block.input.filePath || block.input.file_path}\`\n`;
                } else {
                  toolLine += "\n";
                }
                queue.push(toolLine, "tool_use");
                totalOutput += toolLine.length;
                this.saveHistory?.(toolLine, "tool_use").catch(() => {});
              }
            }
          } else if (evt.type === "result") {
            // Final result event — extract text if present
            for (const block of evt.result ?? []) {
              if (block.type === "text" && block.text) {
                queue.push(block.text, "text");
                totalOutput += block.text.length;
              }
            }
          }
        }
      });

      child.on("close", async (code) => {
        // Process any remaining partial line in the buffer
        if (ndjsonBuffer.trim()) {
          try {
            const evt = JSON.parse(ndjsonBuffer.trim());
            if (evt.type === "assistant") {
              for (const block of evt.message?.content ?? []) {
                if (block.type === "text") {
                  queue.push(block.text, "text");
                  totalOutput += block.text.length;
                  this.saveHistory?.(block.text, "text").catch(() => {});
                } else if (block.type === "tool_use") {
                  let toolLine = `\n\`[${block.name}]\` `;
                  if (block.input?.command) {
                    toolLine += `\`$ ${block.input.command}\`\n`;
                  } else if (block.input?.filePath || block.input?.file_path) {
                    toolLine += `\`${block.input.filePath || block.input.file_path}\`\n`;
                  } else {
                    toolLine += "\n";
                  }
                  queue.push(toolLine, "tool_use");
                  totalOutput += toolLine.length;
                  this.saveHistory?.(toolLine, "tool_use").catch(() => {});
                }
              }
            }
          } catch {
            // ignore
          }
        }

        // Drain all pending sends
        await queue.drain();

        // Stop typing indicator
        this.stopTyping();

        // Rate limited — try GPT fallback if available
        if (rateLimited && !authFailed && this.gptFallback) {
          logger.warn({ sessionId: this.id, totalOutput }, "Edit session: Claude rate limited, trying GPT fallback");
          await this.sendMessage("_Claude atingiu o limite. Redirecionando para GPT Codex..._");
          try {
            const lastPrompt = this.lastFailedPrompt?.text || "Continue the previous task";
            const gptResult = await this.gptFallback(lastPrompt);
            queue.push(gptResult);
            await queue.drain();
          } catch (err) {
            logger.error({ err, sessionId: this.id }, "GPT fallback failed in edit session");
            await this.sendMessage(`_Fallback GPT tambem falhou: ${(err as Error).message}_`);
          }
          this.state = "ready";
          resolve();
          return;
        }

        if (authFailed && this.onAuthExpired) {
          // Token expired — try auto-refresh via callback
          logger.warn({ sessionId: this.id, totalOutput }, "Edit session: auth expired, attempting refresh");
          this.state = "auth_expired";
          // Record whether output was already sent before the 401
          if (this.lastFailedPrompt) {
            this.lastFailedPrompt.hadOutput = totalOutput > 0;
          }

          const refreshed = await this.onAuthExpired();
          // If refreshed, refreshCredentials() will set state back to ready
          // and retry the failed prompt. If not, state stays auth_expired
          // and user needs to re-authenticate.
          if (!refreshed) {
            logger.info({ sessionId: this.id }, "Edit session: waiting for re-auth");
          }
        } else {
          if (totalOutput === 0) {
            await this.sendMessage("_(sem output)_");
          }
          this.state = "ready";
        }

        logger.info(
          { sessionId: this.id, exitCode: code, totalOutput, authFailed },
          "Edit session claude completed"
        );

        resolve();
      });
    });
  }

  /**
   * Proactively refresh the token inside the container before each Claude invocation.
   * This prevents 401s by ensuring credentials are always fresh.
   */
  private async ensureFreshToken(): Promise<void> {
    if (!this.getFreshToken || !this.containerId) return;

    try {
      const tokens = await this.getFreshToken();
      if (tokens) {
        const credsJson = JSON.stringify({
          claudeAiOauth: {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken || "",
            expiresAt: Date.now() + 3600 * 1000,
            scopes: ["user:inference"],
          },
        });
        await execFileAsync("docker", [
          "exec", this.containerName,
          "sh", "-c",
          `echo '${credsJson.replace(/'/g, "'\\''")}' > /home/claude/.claude/.credentials.json`,
        ]);
        logger.debug({ sessionId: this.id }, "Edit session: proactive token refresh");
      }
    } catch (err) {
      logger.warn({ err, sessionId: this.id }, "Edit session: proactive token refresh failed");
    }
  }

  /**
   * Send a user message to Claude Code (first prompt).
   * If medias is provided (images), each is written to /tmp inside the container
   * and the prompt is augmented to tell Claude Code to read all image files.
   */
  async sendPrompt(prompt: string, medias?: MediaAttachment[]): Promise<void> {
    if (this.state === "auth_expired") {
      await this.sendMessage("Aguardando re-autenticacao do Claude. Cole o codigo OAuth ou use */exit*.");
      return;
    }
    if (this.state !== "ready") {
      await this.sendMessage("Aguarde, ainda estou processando...");
      return;
    }

    this.state = "running";
    await this.ensureFreshToken();
    this.lastFailedPrompt = { text: prompt, medias, isContinue: false, hadOutput: false };
    const augmentedPrompt = await this.augmentPromptWithImages(prompt, medias);
    // Pass prompt as a direct argument — no shell escaping needed.
    // Node's spawn() passes each arg via execve(), so no shell metacharacters
    // are interpreted regardless of prompt content.
    await this.runClaude([
      "claude", "-p", augmentedPrompt,
      "--system-prompt", EDIT_SYSTEM_PROMPT,
      "--output-format", "stream-json",
      "--dangerously-skip-permissions",
      "--verbose",
    ]);
    if ((this.state as EditState) === "ready") this.lastFailedPrompt = null;
  }

  /**
   * Continue a previous Claude Code conversation.
   */
  async sendContinue(prompt: string, medias?: MediaAttachment[]): Promise<void> {
    if (this.state === "auth_expired") {
      await this.sendMessage("Aguardando re-autenticacao do Claude. Cole o codigo OAuth ou use */exit*.");
      return;
    }
    if (this.state !== "ready") {
      await this.sendMessage("Aguarde, ainda estou processando...");
      return;
    }

    this.state = "running";
    await this.ensureFreshToken();
    this.lastFailedPrompt = { text: prompt, medias, isContinue: true, hadOutput: false };
    const augmentedPrompt = await this.augmentPromptWithImages(prompt, medias);
    // Pass prompt as a direct argument — no shell escaping needed.
    await this.runClaude([
      "claude", "-p", augmentedPrompt,
      "--continue",
      "--system-prompt", EDIT_SYSTEM_PROMPT,
      "--output-format", "stream-json",
      "--dangerously-skip-permissions",
      "--verbose",
    ]);
    if ((this.state as EditState) === "ready") this.lastFailedPrompt = null;
  }

  /**
   * Inject all images into the container and augment the prompt to reference each one.
   * Claude Code CLI doesn't support --image, so we docker cp each file in
   * and tell Claude to read them with its Read tool.
   * Returns the original prompt if no images, or augmented prompt with all image paths.
   */
  private async augmentPromptWithImages(prompt: string, medias?: MediaAttachment[]): Promise<string> {
    if (!medias || medias.length === 0 || !this.containerId) {
      return prompt;
    }

    const imagePaths: string[] = [];

    for (const media of medias) {
      if (!media.mimeType.startsWith("image/")) continue;

      try {
        const ext = media.mimeType.split("/")[1]?.replace("jpeg", "jpg") || "png";
        const containerPath = `/tmp/edit-image-${Date.now()}-${randomBytes(2).toString("hex")}.${ext}`;

        // Write image to a host temp file, then docker cp into the container.
        const tmpFile = join(tmpdir(), `edit-image-${randomBytes(4).toString("hex")}.${ext}`);
        await writeFile(tmpFile, media.data);
        try {
          await execFileAsync("docker", ["cp", tmpFile, `${this.containerName}:${containerPath}`]);
        } finally {
          await unlink(tmpFile).catch(() => {});
        }

        logger.info({ containerPath, size: media.data.length, mimeType: media.mimeType, sessionId: this.id }, "Image injected into edit container");
        imagePaths.push(containerPath);
      } catch (err) {
        logger.warn({ err, sessionId: this.id }, "Failed to inject image into edit container");
      }
    }

    if (imagePaths.length === 0) return prompt;

    const imageInstructions = imagePaths
      .map((p) => `[O usuario anexou uma imagem. Use o Read tool para ler o arquivo de imagem em: ${p}]`)
      .join("\n");

    return `${prompt}\n\n${imageInstructions}`;
  }

  /**
   * Trigger the safe deploy pipeline.
   */
  async deploy(): Promise<void> {
    if (this.state !== "ready") {
      await this.sendMessage("Aguarde o processamento atual terminar antes de fazer deploy.");
      return;
    }

    this.state = "deploying";
    await this.sendMessage("*Iniciando deploy seguro...*\nEtapas: build (inclui tsc) → smoke test → swap → watchdog");

    const projectDir = process.env.HOST_PROJECT_DIR || "/home/ubuntu/rick-ai";

    const child = spawn("docker", [
      "run", "--rm",
      "-v", "/var/run/docker.sock:/var/run/docker.sock",
      "-v", `${projectDir}:${projectDir}`,
      "-v", `/tmp:/tmp`,
      "-v", `${projectDir}/scripts/deploy.sh:/deploy.sh:ro`,
      "-e", `PROJECT_DIR=${projectDir}`,
      "--network", "host",
      "docker:cli",
      "sh", "/deploy.sh", this.stagingDir,
    ]);

    let output = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      const lines = text.split("\n").filter((l: string) => l.includes("[deploy]"));
      for (const line of lines) {
        // Extrai somente a mensagem útil, descartando o timestamp embutido do script
        // Formato original: "[deploy] HH:MM:SS mensagem"
        // Formato desejado: `[deploy]` mensagem  (igual ao padrão das outras tools)
        const match = /\[deploy\]\s*[\d:]*\s*(.*)/.exec(line.trim());
        const msg = match ? match[1].trim() : line.trim();
        this.sendMessage(`\`[deploy]\` ${msg}`, "tool_use").catch(() => {});
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    child.on("close", async (code) => {
      if (code === 0) {
        await this.sendMessage(
          "*Deploy concluido com sucesso!*\n\n" +
          "O Rick foi atualizado e esta rodando com o novo codigo.\n" +
          "Essa sessao de edicao sera encerrada agora."
        );
        await this.close();
      } else {
        const exitMessages: Record<number, string> = {
          1: "Build falhou (provavelmente erros de TypeScript). Verifique os erros acima.",
          2: "Smoke test falhou — o novo codigo nao passou no health check.",
          3: "Watchdog detectou falha apos o swap — rollback realizado.",
          4: "CRITICO: Rollback tambem falhou! Verificacao manual necessaria.",
        };
        const reason = exitMessages[code || 0] || `Codigo de saida: ${code}`;
        await this.sendMessage(
          `*Deploy falhou!* Rollback automatico realizado.\n\nMotivo: ${reason}\n\n` +
          `Voce ainda esta no modo de edicao. Corrija o problema e tente */deploy* novamente, ou */exit* para descartar.`
        );
        this.state = "ready";
      }

      logger.info(
        { sessionId: this.id, exitCode: code, outputLen: output.length },
        "Deploy pipeline completed"
      );
    });
  }

  /**
   * Build environment variables for the Agent API (JWT token + upfront credentials).
   * Called from start() before creating the Docker container.
   */
  private async buildAgentApiEnv(): Promise<Record<string, string>> {
    const agentEnv: Record<string, string> = {};

    // JWT token for authenticating against Rick's /api/agent/* endpoints
    const token = createAgentToken(this.id, this.userId, 7200); // 2h TTL
    const apiUrl = `http://host.docker.internal:${config.webPort}`;
    agentEnv.RICK_SESSION_TOKEN = token;
    agentEnv.RICK_API_URL = apiUrl;

    // Resolve upfront credentials from sensitive memory categories.
    // The MemoryService decrypts automatically (AES-256-GCM) — the sub-agent
    // receives plaintext values, never the MEMORY_ENCRYPTION_KEY itself.
    if (this.memoryService) {
      try {
        const sensitiveCategories = ["credenciais", "tokens", "senhas", "secrets", "passwords", "credentials"];
        for (const category of sensitiveCategories) {
          const mems = await this.memoryService.listMemories(this.userId, category);
          for (const mem of mems) {
            // "github_token" → "RICK_SECRET_GITHUB_TOKEN"
            const envKey = `RICK_SECRET_${mem.key
              .toUpperCase()
              .replace(/[^A-Z0-9]+/g, "_")
              .replace(/^_|_$/g, "")}`;
            agentEnv[envKey] = mem.value;
          }
        }
        logger.info(
          { sessionId: this.id, secretCount: Object.keys(agentEnv).length - 2 },
          "Edit session: upfront credentials resolved",
        );
      } catch (err) {
        logger.warn({ err, sessionId: this.id }, "Edit session: failed to resolve upfront credentials");
      }
    }

    return agentEnv;
  }

  /**
   * Close the edit session — kill container and clean up staging dir.
   */
  async close(): Promise<void> {
    if (this.state === "closed") return;

    this.stopTyping();

    if (this.containerId) {
      try {
        await execFileAsync("docker", ["rm", "-f", this.containerName]);
        logger.info({ sessionId: this.id }, "Edit session container killed");
      } catch (err) {
        logger.warn({ err }, "Failed to kill edit container");
      }
    }

    try {
      await execFileAsync("docker", [
        "run", "--rm",
        "-v", "/tmp:/tmp",
        "node:22-slim",
        "rm", "-rf", this.stagingDir,
      ]);
    } catch (err) {
      logger.warn({ err, stagingDir: this.stagingDir }, "Failed to clean staging dir");
    }

    this.state = "closed";
    logger.info({ sessionId: this.id }, "Edit session closed");

    // Notify caller (e.g. Agent) so it can clear its editSession reference
    this.onClose?.();
  }

  /**
   * Kill all orphaned edit-session containers and clean up their staging dirs.
   *
   * Called on agent startup to clean up containers that survived a restart
   * (since the in-memory editSession reference is lost on restart, those
   * containers would run forever with no way to stop them).
   *
   * Also called periodically by the reaper interval.
   */
  static async cleanupOrphans(): Promise<number> {
    try {
      const { stdout } = await execFileAsync("docker", [
        "ps", "-q", "--filter", "name=edit-session",
      ]);

      const ids = stdout.trim().split("\n").filter(Boolean);
      if (ids.length === 0) return 0;

      // Kill all edit-session containers
      await execFileAsync("docker", ["rm", "-f", ...ids]);

      // Clean up staging dirs
      try {
        await execFileAsync("bash", [
          "-c",
          "rm -rf /tmp/rick-edit-* 2>/dev/null || true",
        ]);
      } catch {
        // Staging dir cleanup is best-effort
      }

      logger.info({ count: ids.length }, "Cleaned up orphaned edit-session containers");
      return ids.length;
    } catch (err) {
      logger.warn({ err }, "Failed to clean up orphaned edit-session containers");
      return 0;
    }
  }

  /**
   * Start a periodic reaper that kills edit-session containers older than maxAge.
   * Returns a cleanup function to stop the interval.
   *
   * @param intervalMs - How often to check (default: 30 minutes)
   * @param maxAgeMs - Max container age before killing (default: 2 hours)
   */
  static startReaper(intervalMs = 30 * 60 * 1000, maxAgeMs = 2 * 60 * 60 * 1000): () => void {
    const interval = setInterval(async () => {
      try {
        // Get edit-session containers with their creation time
        const { stdout } = await execFileAsync("docker", [
          "ps", "--filter", "name=edit-session",
          "--format", "{{.Names}}\t{{.CreatedAt}}",
        ]);

        const lines = stdout.trim().split("\n").filter(Boolean);
        const now = Date.now();
        const stale: string[] = [];

        for (const line of lines) {
          const [name, ...createdParts] = line.split("\t");
          const createdStr = createdParts.join("\t");
          const created = new Date(createdStr).getTime();

          if (now - created > maxAgeMs) {
            stale.push(name);
          }
        }

        if (stale.length > 0) {
          await execFileAsync("docker", ["rm", "-f", ...stale]);

          // Clean up their staging dirs
          for (const name of stale) {
            const id = name.replace("edit-session-", "");
            try {
              await execFileAsync("rm", ["-rf", `/tmp/rick-edit-${id}`]);
            } catch {
              // best-effort
            }
          }

          logger.info({ count: stale.length, containers: stale }, "Reaped stale edit-session containers");
        }
      } catch (err) {
        logger.warn({ err }, "Edit session reaper error");
      }
    }, intervalMs);

    return () => clearInterval(interval);
  }
}
