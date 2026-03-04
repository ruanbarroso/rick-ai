import { execFile } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { logger } from "../config/logger.js";

const execFileAsync = promisify(execFile);

const CURRENT_IMAGE = "subagent:current";
const NEXT_IMAGE = "subagent:next";
const LEGACY_IMAGE = "subagent";

export const SUBAGENT_RUNTIME_IMAGE = CURRENT_IMAGE;

export type SessionImageStatus = "building_fresh" | "waiting_first_build" | "using_stale";

class SubagentImageBuilder {
  private inFlightBuild: Promise<void> | null = null;
  private readyFingerprint: string | null = null;

  private getLocalFingerprint(): { hash: string; version: string; fingerprint: string; dockerfilePath: string; localAppDir: string } {
    const localAppDir = process.cwd();
    const agentMjsPath = `${localAppDir}/docker/agent.mjs`;
    const sharedToolsPath = `${localAppDir}/docker/tools.mjs`;
    const sharedDeclsPath = `${localAppDir}/docker/tool-declarations.mjs`;
    const rickApiPath = `${localAppDir}/docker/rick-api.mjs`;
    const browserAgentPath = `${localAppDir}/docker/browser-agent.mjs`;
    const subagentPackagePath = `${localAppDir}/docker/subagent.package.json`;
    const dockerfilePath = `${localAppDir}/docker/subagent.Dockerfile`;
    const versionFilePath = `${localAppDir}/.rick-version`;
    const packageJsonPath = `${localAppDir}/package.json`;

    const hash = createHash("sha256")
      .update(readFileSync(agentMjsPath))
      .update("\n---\n")
      .update(readFileSync(sharedToolsPath))
      .update("\n---\n")
      .update(readFileSync(sharedDeclsPath))
      .update("\n---\n")
      .update(readFileSync(rickApiPath))
      .update("\n---\n")
      .update(readFileSync(browserAgentPath))
      .update("\n---\n")
      .update(readFileSync(subagentPackagePath))
      .update("\n---\n")
      .update(readFileSync(dockerfilePath))
      .digest("hex")
      .substring(0, 16);

    let version = "unknown";
    try {
      if (existsSync(versionFilePath)) {
        const first = readFileSync(versionFilePath, "utf-8")
          .split(/\r?\n/)
          .map((s) => s.trim())
          .find(Boolean);
        if (first) version = first;
      } else {
        const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { version?: string };
        if (pkg.version) version = `pkg-${pkg.version}`;
      }
    } catch {
      // keep unknown
    }

    return {
      hash,
      version,
      fingerprint: `${hash}|${version}`,
      dockerfilePath,
      localAppDir,
    };
  }

  private async imageExists(imageRef: string): Promise<boolean> {
    try {
      await execFileAsync("docker", ["image", "inspect", imageRef], { timeout: 10_000 });
      return true;
    } catch {
      return false;
    }
  }

  private async imageFingerprint(imageRef: string): Promise<{ hash: string; version: string; fingerprint: string } | null> {
    try {
      const { stdout } = await execFileAsync("docker", [
        "inspect",
        "--format",
        "{{index .Config.Labels \"agent.bundle.hash\"}}|{{index .Config.Labels \"rick.version\"}}",
        imageRef,
      ], { timeout: 10_000 });
      const out = stdout.trim();
      if (!out) return null;
      const [hash = "", version = ""] = out.split("|");
      return { hash, version, fingerprint: out };
    } catch {
      return null;
    }
  }

  /**
   * Re-label the existing image with updated version metadata (no rebuild).
   * Uses `docker build` with a trivial FROM+LABEL Dockerfile piped via shell,
   * which is instant because no layers change.
   */
  private async relabel(imageRef: string, targetTag: string, local: { hash: string; version: string }): Promise<void> {
    logger.info({ hash: local.hash, version: local.version, imageRef }, "Re-labeling subagent image (content unchanged, version updated)");
    const { execSync } = await import("node:child_process");
    execSync(
      `printf 'FROM ${imageRef}\\nLABEL agent.bundle.hash=${local.hash} rick.version=${local.version}\\n' | docker build -t ${targetTag} -f - .`,
      { timeout: 30_000 },
    );
    execFileAsync("docker", ["image", "prune", "-f"], { timeout: 30_000 }).catch(() => {});
    logger.info({ hash: local.hash, version: local.version }, "subagent image re-labeled successfully");
  }

  private async ensureCurrentTagExists(): Promise<void> {
    if (await this.imageExists(CURRENT_IMAGE)) return;
    if (!(await this.imageExists(LEGACY_IMAGE))) return;

    try {
      await execFileAsync("docker", ["tag", LEGACY_IMAGE, CURRENT_IMAGE], { timeout: 10_000 });
      logger.info("Tagged legacy subagent image as subagent:current");
    } catch (err) {
      logger.warn({ err }, "Failed to tag legacy subagent image as current");
    }
  }

  private async buildAndPromote(local: { hash: string; version: string; dockerfilePath: string; localAppDir: string }): Promise<void> {
    logger.info({ hash: local.hash, version: local.version }, "Building subagent image from docker/subagent.Dockerfile");

    await execFileAsync(
      "docker",
      [
        "build",
        "-t",
        NEXT_IMAGE,
        "--label",
        `agent.bundle.hash=${local.hash}`,
        "--label",
        `rick.version=${local.version}`,
        "-f",
        local.dockerfilePath,
        local.localAppDir,
      ],
      { timeout: 600_000 },
    );

    await execFileAsync("docker", ["tag", NEXT_IMAGE, CURRENT_IMAGE], { timeout: 10_000 });
    await execFileAsync("docker", ["tag", NEXT_IMAGE, LEGACY_IMAGE], { timeout: 10_000 });

    // Clean up the old image that became dangling after re-tagging
    execFileAsync("docker", ["image", "prune", "-f"], { timeout: 30_000 }).catch(() => {});

    this.readyFingerprint = `${local.hash}|${local.version}`;
    logger.info({ hash: local.hash, version: local.version }, "subagent image built and promoted successfully");
  }

  private async buildWithLock(local: { hash: string; version: string; fingerprint: string; dockerfilePath: string; localAppDir: string }): Promise<void> {
    if (this.inFlightBuild) {
      await this.inFlightBuild;
      return;
    }

    const buildPromise = this.buildAndPromote(local)
      .catch((err) => {
        logger.error({ err }, "Failed to build subagent image");
        throw new Error("Falha ao construir imagem do sub-agente. Verifique os logs.");
      })
      .finally(() => {
        if (this.inFlightBuild === buildPromise) {
          this.inFlightBuild = null;
        }
      });

    this.inFlightBuild = buildPromise;
    await buildPromise;
  }

  private async startBackgroundBuild(local: { hash: string; version: string; fingerprint: string; dockerfilePath: string; localAppDir: string }, reason: string): Promise<void> {
    if (this.inFlightBuild) return;
    this.buildWithLock(local)
      .then(() => logger.info({ reason }, "Subagent image background build completed"))
      .catch((err) => logger.warn({ err, reason }, "Subagent image background build failed"));
  }

  async ensureForSession(opts?: { onStatus?: (status: SessionImageStatus) => void }): Promise<string> {
    const local = this.getLocalFingerprint();

    await this.ensureCurrentTagExists();

    if (this.readyFingerprint === local.fingerprint && await this.imageExists(CURRENT_IMAGE)) {
      return CURRENT_IMAGE;
    }

    const current = await this.imageFingerprint(CURRENT_IMAGE);
    const hasCurrent = current !== null || await this.imageExists(CURRENT_IMAGE);

    if (current?.fingerprint === local.fingerprint) {
      this.readyFingerprint = local.fingerprint;
      return CURRENT_IMAGE;
    }

    // Content hash matches — only version label differs. Re-label instantly.
    if (current && current.hash === local.hash) {
      await this.relabel(CURRENT_IMAGE, CURRENT_IMAGE, local);
      // Also tag as legacy for compatibility
      await execFileAsync("docker", ["tag", CURRENT_IMAGE, LEGACY_IMAGE], { timeout: 10_000 }).catch(() => {});
      this.readyFingerprint = `${local.hash}|${local.version}`;
      return CURRENT_IMAGE;
    }

    if (current) {
      logger.info(
        {
          localHash: local.hash,
          imageHash: current.hash || "(none)",
          localVersion: local.version,
          imageVersion: current.version || "(none)",
        },
        "subagent current image out of date",
      );
    }

    if (this.inFlightBuild) {
      if (hasCurrent) {
        opts?.onStatus?.("using_stale");
        return CURRENT_IMAGE;
      }
      opts?.onStatus?.("waiting_first_build");
      await this.inFlightBuild;
      return CURRENT_IMAGE;
    }

    if (hasCurrent) {
      opts?.onStatus?.("using_stale");
      await this.startBackgroundBuild(local, "session_stale_image");
      return CURRENT_IMAGE;
    }

    opts?.onStatus?.("building_fresh");
    await this.buildWithLock(local);
    return CURRENT_IMAGE;
  }

  private warmupRetries = 0;
  private static readonly MAX_WARMUP_RETRIES = 3;

  warmup(reason: string): void {
    let local: ReturnType<typeof this.getLocalFingerprint>;
    try {
      local = this.getLocalFingerprint();
    } catch (err) {
      logger.warn({ err, reason }, "Subagent image warmup skipped — failed to compute fingerprint");
      return;
    }
    this.ensureCurrentTagExists()
      .then(() => this.imageFingerprint(CURRENT_IMAGE))
      .then((image) => {
        if (image?.fingerprint === local.fingerprint) {
          this.readyFingerprint = local.fingerprint;
          logger.info({ reason }, "Subagent image already up to date");
          return;
        }
        // Content hash matches — only version label differs. Re-label instantly.
        if (image && image.hash === local.hash) {
          return this.relabel(CURRENT_IMAGE, CURRENT_IMAGE, local).then(() => {
            execFileAsync("docker", ["tag", CURRENT_IMAGE, LEGACY_IMAGE], { timeout: 10_000 }).catch(() => {});
            this.readyFingerprint = `${local.hash}|${local.version}`;
          });
        }
        logger.info({ reason, imageFingerprint: image?.fingerprint ?? null, localFingerprint: local.fingerprint }, "Subagent image warmup starting build");
        return this.startBackgroundBuild(local, reason);
      })
      .catch(async (err) => {
        this.warmupRetries++;
        if (this.warmupRetries > SubagentImageBuilder.MAX_WARMUP_RETRIES) {
          logger.error({ err, reason, retries: this.warmupRetries }, "Subagent image warmup failed — max retries reached, giving up");
          return;
        }
        // Try to free disk space before retrying
        try {
          await execFileAsync("docker", ["builder", "prune", "-f"], { timeout: 30_000 });
          logger.info("Pruned Docker build cache before subagent image retry");
        } catch { /* best effort */ }
        logger.warn({ err, reason, retry: this.warmupRetries }, "Subagent image warmup failed — scheduling retry in 60s");
        setTimeout(() => this.warmup(`${reason}_retry`), 60_000);
      });
  }
}

export const subagentImageBuilder = new SubagentImageBuilder();
