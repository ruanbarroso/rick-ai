import { execFile } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { logger } from "../config/logger.js";

const execFileAsync = promisify(execFile);

const CURRENT_IMAGE = "subagent:current";
const NEXT_IMAGE = "subagent:next";
const LEGACY_IMAGE = "subagent";
const BASE_IMAGE = "subagent-base:chrome";

export const SUBAGENT_RUNTIME_IMAGE = CURRENT_IMAGE;

export type SessionImageStatus = "building_fresh" | "waiting_first_build" | "using_stale";

class SubagentImageBuilder {
  private inFlightBuild: Promise<void> | null = null;
  /** Fingerprint that the in-flight build will produce (so callers can decide whether to wait). */
  private inFlightFingerprint: string | null = null;
  private readyFingerprint: string | null = null;

  private getLocalFingerprint(): {
    hash: string;
    version: string;
    fingerprint: string;
    dockerfilePath: string;
    fastDockerfilePath: string;
    dockerDir: string;
  } {
    const localAppDir = process.cwd();
    const dockerDir = `${localAppDir}/docker`;
    const agentMjsPath = `${dockerDir}/agent.mjs`;
    const sharedToolsPath = `${dockerDir}/tools.mjs`;
    const sharedDeclsPath = `${dockerDir}/tool-declarations.mjs`;
    const rickApiPath = `${dockerDir}/rick-api.mjs`;
    const mcpPlaywrightPath = `${dockerDir}/mcp-playwright.mjs`;
    const rickMcpPath = `${dockerDir}/rick-mcp.mjs`;
    const opencodeConfigPath = `${dockerDir}/opencode.json`;
    const policyMjsPath = `${dockerDir}/policy.mjs`;
    const promptMjsPath = `${dockerDir}/prompt.mjs`;
    const agentsMdPath = `${dockerDir}/AGENTS.md`;
    const streamBridgePath = `${dockerDir}/stream-bridge.mjs`;
    const subagentPackagePath = `${dockerDir}/subagent.package.json`;
    const dockerfilePath = `${dockerDir}/subagent.Dockerfile`;
    const fastDockerfilePath = `${dockerDir}/subagent-fast.Dockerfile`;
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
      .update(readFileSync(mcpPlaywrightPath))
      .update("\n---\n")
      .update(readFileSync(rickMcpPath))
      .update("\n---\n")
      .update(readFileSync(opencodeConfigPath))
      .update("\n---\n")
      .update(readFileSync(policyMjsPath))
      .update("\n---\n")
      .update(readFileSync(promptMjsPath))
      .update("\n---\n")
      .update(existsSync(agentsMdPath) ? readFileSync(agentsMdPath) : "")
      .update("\n---\n")
      .update(existsSync(streamBridgePath) ? readFileSync(streamBridgePath) : "")
      .update("\n---\n")
      .update(readFileSync(subagentPackagePath))
      .update("\n---\n")
      .update(readFileSync(dockerfilePath))
      .update("\n---\n")
      .update(readFileSync(fastDockerfilePath))
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
      fastDockerfilePath,
      dockerDir,
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
      // If both labels are empty, the image has no fingerprint metadata
      if (!hash && !version) return null;
      return { hash, version, fingerprint: out };
    } catch {
      return null;
    }
  }

  /**
   * Re-label the existing image with updated version metadata (no rebuild).
   * Uses `docker tag` (zero new layers) to avoid accumulating overlay depth
   * that leads to "max depth exceeded" errors on overlay2 storage driver.
   */
  private async relabel(imageRef: string, targetTag: string, local: { hash: string; version: string }): Promise<void> {
    logger.info({ hash: local.hash, version: local.version, imageRef }, "Re-labeling subagent image (content unchanged, version updated)");
    await execFileAsync("docker", ["tag", imageRef, targetTag], { timeout: 10_000 });
    execFileAsync("docker", ["image", "prune", "-f"], { timeout: 30_000 }).catch(() => {});
    logger.info({ hash: local.hash, version: local.version }, "subagent image re-labeled successfully");
  }

  /**
   * Find an untagged (dangling) subagent image by checking for the
   * `agent.bundle.hash` label. Returns the image ID or null.
   * This rescues orphaned subagent images whose tags were lost during
   * deploys, prune operations, or other Docker lifecycle events.
   */
  private async findOrphanSubagentImage(): Promise<string | null> {
    try {
      // List all images (including untagged) that carry our label
      const { stdout } = await execFileAsync("docker", [
        "images", "--filter", "label=agent.bundle.hash", "--format", "{{.ID}}",
      ], { timeout: 10_000 });
      const ids = stdout.trim().split(/\s+/).filter(Boolean);
      return ids.length > 0 ? ids[0] : null;
    } catch {
      return null;
    }
  }

  private async ensureCurrentTagExists(): Promise<void> {
    if (await this.imageExists(CURRENT_IMAGE)) return;

    // Try legacy tag first
    if (await this.imageExists(LEGACY_IMAGE)) {
      try {
        await execFileAsync("docker", ["tag", LEGACY_IMAGE, CURRENT_IMAGE], { timeout: 10_000 });
        logger.info("Tagged legacy subagent image as subagent:current");
        return;
      } catch (err) {
        logger.warn({ err }, "Failed to tag legacy subagent image as current");
      }
    }

    // Last resort: rescue an orphaned (untagged) subagent image
    const orphanId = await this.findOrphanSubagentImage();
    if (orphanId) {
      try {
        await execFileAsync("docker", ["tag", orphanId, CURRENT_IMAGE], { timeout: 10_000 });
        logger.info({ imageId: orphanId }, "Rescued orphan subagent image as subagent:current");
      } catch (err) {
        logger.warn({ err, imageId: orphanId }, "Failed to rescue orphan subagent image");
      }
    }
  }

  private async ensureBaseImageExists(): Promise<void> {
    if (await this.imageExists(BASE_IMAGE)) return;

    if (await this.imageExists(CURRENT_IMAGE)) {
      try {
        await execFileAsync("docker", ["tag", CURRENT_IMAGE, BASE_IMAGE], { timeout: 10_000 });
        logger.info({ source: CURRENT_IMAGE, target: BASE_IMAGE }, "Seeded local subagent base image");
        return;
      } catch (err) {
        logger.warn({ err }, "Failed to seed local base image from current tag");
      }
    }

    if (await this.imageExists(LEGACY_IMAGE)) {
      try {
        await execFileAsync("docker", ["tag", LEGACY_IMAGE, BASE_IMAGE], { timeout: 10_000 });
        logger.info({ source: LEGACY_IMAGE, target: BASE_IMAGE }, "Seeded local subagent base image from legacy tag");
        return;
      } catch (err) {
        logger.warn({ err }, "Failed to seed local base image from legacy tag");
      }
    }

    // Last resort: rescue an orphan
    const orphanId = await this.findOrphanSubagentImage();
    if (orphanId) {
      try {
        await execFileAsync("docker", ["tag", orphanId, BASE_IMAGE], { timeout: 10_000 });
        logger.info({ imageId: orphanId }, "Rescued orphan subagent image as subagent-base:chrome");
      } catch (err) {
        logger.warn({ err, imageId: orphanId }, "Failed to rescue orphan as base image");
      }
    }
  }

  private async buildAndPromote(local: { hash: string; version: string; dockerfilePath: string; fastDockerfilePath: string; dockerDir: string }): Promise<void> {
    const hasBaseImage = await this.imageExists(BASE_IMAGE);
    let selectedDockerfile = hasBaseImage ? local.fastDockerfilePath : local.dockerfilePath;
    let buildMode = hasBaseImage ? "fast" : "bootstrap";

    // Bootstrap builds install Playwright + Chrome + system deps (~300MB+) and
    // can easily take 15-20 minutes on modest hardware or slow networks.
    // Fast builds only copy source files and run `npm install`, finishing in ~2 min.
    let buildTimeout = buildMode === "bootstrap" ? 1_800_000 : 600_000; // 30 min / 10 min

    logger.info(
      {
        hash: local.hash,
        version: local.version,
        buildMode,
        dockerfile: selectedDockerfile,
        hasBaseImage,
        timeoutMs: buildTimeout,
      },
      "Building subagent image",
    );

    try {
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
          selectedDockerfile,
          local.dockerDir,
        ],
        { timeout: buildTimeout, maxBuffer: 50 * 1024 * 1024 },
      );
    } catch (buildErr: unknown) {
      const errMsg = String((buildErr as Error)?.message || buildErr);
      // overlay2 "max depth exceeded": base image has too many layers from
      // repeated fast rebuilds / relabels.  Drop the stale base and retry
      // with a full bootstrap build from node:22-slim.
      if (buildMode === "fast" && /max depth exceeded/i.test(errMsg)) {
        logger.warn("Fast build hit overlay2 max depth — falling back to full bootstrap build");
        try { await execFileAsync("docker", ["rmi", "-f", BASE_IMAGE], { timeout: 15_000 }); } catch { /* ignore */ }
        selectedDockerfile = local.dockerfilePath;
        buildMode = "bootstrap";
        buildTimeout = 1_800_000;
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
            selectedDockerfile,
            local.dockerDir,
          ],
          { timeout: buildTimeout, maxBuffer: 50 * 1024 * 1024 },
        );
      } else {
        throw buildErr;
      }
    }

    await execFileAsync("docker", ["tag", NEXT_IMAGE, CURRENT_IMAGE], { timeout: 10_000 });
    await execFileAsync("docker", ["tag", NEXT_IMAGE, LEGACY_IMAGE], { timeout: 10_000 });

    // Keep a local reusable base image to speed up future builds when CI is not available.
    await execFileAsync("docker", ["tag", NEXT_IMAGE, BASE_IMAGE], { timeout: 10_000 }).catch((err) => {
      logger.warn({ err }, "Failed to refresh local subagent base image tag");
    });

    // Clean up the old image that became dangling after re-tagging
    execFileAsync("docker", ["image", "prune", "-f"], { timeout: 30_000 }).catch(() => {});

    this.readyFingerprint = `${local.hash}|${local.version}`;
    logger.info({ hash: local.hash, version: local.version, buildMode }, "subagent image built and promoted successfully");
  }

  private async buildWithLock(local: { hash: string; version: string; fingerprint: string; dockerfilePath: string; fastDockerfilePath: string; dockerDir: string }): Promise<void> {
    // If there's already a build in-flight for the SAME fingerprint, just wait for it
    if (this.inFlightBuild && this.inFlightFingerprint === local.fingerprint) {
      await this.inFlightBuild;
      return;
    }

    // If there's a build in-flight for a DIFFERENT fingerprint, wait for it to finish
    // before starting a new one (avoid concurrent docker builds)
    if (this.inFlightBuild) {
      try { await this.inFlightBuild; } catch { /* previous build failed, proceed with new one */ }
    }

    const buildPromise = this.buildAndPromote(local)
      .catch((err) => {
        logger.error({ err }, "Failed to build subagent image");
        throw new Error("Falha ao construir imagem do sub-agente. Verifique os logs.");
      })
      .finally(() => {
        if (this.inFlightBuild === buildPromise) {
          this.inFlightBuild = null;
          this.inFlightFingerprint = null;
        }
      });

    this.inFlightBuild = buildPromise;
    this.inFlightFingerprint = local.fingerprint;
    await buildPromise;
  }

  private startBackgroundBuild(local: { hash: string; version: string; fingerprint: string; dockerfilePath: string; fastDockerfilePath: string; dockerDir: string }, reason: string): void {
    if (this.inFlightBuild) return;
    this.buildWithLock(local)
      .then(() => logger.info({ reason }, "Subagent image background build completed"))
      .catch((err) => logger.warn({ err, reason }, "Subagent image background build failed"));
  }

  async ensureForSession(opts?: { onStatus?: (status: SessionImageStatus) => void }): Promise<string> {
    const local = this.getLocalFingerprint();

    await this.ensureCurrentTagExists();
    await this.ensureBaseImageExists();

    // Fast path: in-memory cache says image is up to date
    if (this.readyFingerprint === local.fingerprint && await this.imageExists(CURRENT_IMAGE)) {
      return CURRENT_IMAGE;
    }

    const current = await this.imageFingerprint(CURRENT_IMAGE);
    const hasCurrent = await this.imageExists(CURRENT_IMAGE);

    // Image fingerprint matches local — fully up to date
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

    // A build is already in-flight
    if (this.inFlightBuild) {
      // If the build will produce exactly the image we need, wait for it —
      // even if a stale image is available. This avoids launching new sessions
      // on outdated code when the correct image is seconds away.
      if (this.inFlightFingerprint === local.fingerprint) {
        if (hasCurrent) {
          opts?.onStatus?.("using_stale");
        } else {
          opts?.onStatus?.("waiting_first_build");
        }
        try {
          await this.inFlightBuild;
          return CURRENT_IMAGE;
        } catch {
          // Build failed — fall through to use stale image if available
          if (hasCurrent) return CURRENT_IMAGE;
          throw new Error("Falha ao construir imagem do sub-agente e nenhuma imagem anterior disponível.");
        }
      }
      // Build is for a different fingerprint — use stale if available, or wait
      if (hasCurrent) {
        opts?.onStatus?.("using_stale");
        return CURRENT_IMAGE;
      }
      opts?.onStatus?.("waiting_first_build");
      await this.inFlightBuild;
      return CURRENT_IMAGE;
    }

    // No build in-flight — need to kick one off
    if (hasCurrent) {
      opts?.onStatus?.("using_stale");
      this.startBackgroundBuild(local, "session_stale_image");
      return CURRENT_IMAGE;
    }

    // No image at all — must build synchronously
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
      .then(() => this.ensureBaseImageExists())
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
        this.startBackgroundBuild(local, reason);
      })
      .catch(async (err) => {
        this.warmupRetries++;
        if (this.warmupRetries > SubagentImageBuilder.MAX_WARMUP_RETRIES) {
          logger.error({ err, reason, retries: this.warmupRetries }, "Subagent image warmup failed — max retries reached, giving up");
          return;
        }
        // Keep Docker builder cache: pruning here slows down subsequent retries.
        logger.warn({ err, reason, retry: this.warmupRetries }, "Subagent image warmup failed — scheduling retry in 60s");
        setTimeout(() => this.warmup(`${reason}_retry`), 60_000);
      });
  }
}

export const subagentImageBuilder = new SubagentImageBuilder();
