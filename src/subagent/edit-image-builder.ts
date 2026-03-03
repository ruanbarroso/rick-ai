import { execFile } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { logger } from "../config/logger.js";

const execFileAsync = promisify(execFile);

export type EditImageStatus = "building_missing" | "building_outdated" | "waiting";

class EditImageBuilder {
  private inFlightBuild: Promise<void> | null = null;
  private readyFingerprint: string | null = null;

  private getLocalFingerprint(): { hash: string; version: string; fingerprint: string; dockerfilePath: string; localAppDir: string } {
    const localAppDir = process.cwd();
    const editAgentPath = `${localAppDir}/docker/edit-agent.mjs`;
    const sharedToolsPath = `${localAppDir}/docker/tools.mjs`;
    const sharedDeclsPath = `${localAppDir}/docker/tool-declarations.mjs`;
    const rickApiPath = `${localAppDir}/docker/rick-api.mjs`;
    const dockerfilePath = `${localAppDir}/docker/subagent-edit.Dockerfile`;
    const versionFilePath = `${localAppDir}/.rick-version`;
    const packageJsonPath = `${localAppDir}/package.json`;

    const hash = createHash("sha256")
      .update(readFileSync(editAgentPath))
      .update("\n---\n")
      .update(readFileSync(sharedToolsPath))
      .update("\n---\n")
      .update(readFileSync(sharedDeclsPath))
      .update("\n---\n")
      .update(readFileSync(rickApiPath))
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

  private async imageFingerprint(): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(
        "docker",
        [
          "inspect",
          "--format",
          "{{index .Config.Labels \"edit-agent.bundle.hash\"}}|{{index .Config.Labels \"rick.version\"}}",
          "subagent-edit",
        ],
        { timeout: 10_000 },
      );
      const out = stdout.trim();
      return out || null;
    } catch {
      return null;
    }
  }

  private async build(local: { hash: string; version: string; dockerfilePath: string; localAppDir: string }): Promise<void> {
    logger.info({ hash: local.hash, version: local.version }, "Building subagent-edit image from docker/subagent-edit.Dockerfile");
    await execFileAsync(
      "docker",
      [
        "build",
        "-t",
        "subagent-edit",
        "--label",
        `edit-agent.bundle.hash=${local.hash}`,
        "--label",
        `rick.version=${local.version}`,
        "-f",
        local.dockerfilePath,
        local.localAppDir,
      ],
      { timeout: 600_000 },
    );
    // Clean up the old image that became dangling after re-tagging
    execFileAsync("docker", ["image", "prune", "-f"], { timeout: 30_000 }).catch(() => {});

    this.readyFingerprint = `${local.hash}|${local.version}`;
    logger.info({ hash: local.hash, version: local.version }, "subagent-edit image built successfully");
  }

  private async buildWithLock(local: { hash: string; version: string; fingerprint: string; dockerfilePath: string; localAppDir: string }): Promise<void> {
    if (this.inFlightBuild) {
      await this.inFlightBuild;
      return;
    }

    const buildPromise = this.build(local)
      .catch((err) => {
        logger.error({ err }, "Failed to build subagent-edit image");
        throw new Error("Falha ao construir imagem do agente de edicao. Verifique os logs.");
      })
      .finally(() => {
        if (this.inFlightBuild === buildPromise) {
          this.inFlightBuild = null;
        }
      });

    this.inFlightBuild = buildPromise;
    await buildPromise;
  }

  async ensureReady(opts?: { onStatus?: (status: EditImageStatus) => void }): Promise<void> {
    const local = this.getLocalFingerprint();

    if (this.readyFingerprint === local.fingerprint) return;

    if (this.inFlightBuild) {
      opts?.onStatus?.("waiting");
      await this.inFlightBuild;
      return;
    }

    const imageFingerprint = await this.imageFingerprint();
    if (imageFingerprint === local.fingerprint) {
      this.readyFingerprint = local.fingerprint;
      return;
    }

    if (!imageFingerprint) {
      opts?.onStatus?.("building_missing");
      await this.buildWithLock(local);
      return;
    }

    const [imageHash = "", imageVersion = ""] = imageFingerprint.split("|");
    logger.info(
      {
        localHash: local.hash,
        imageHash: imageHash || "(none)",
        localVersion: local.version,
        imageVersion: imageVersion || "(none)",
      },
      "subagent-edit image out of date — rebuilding",
    );

    opts?.onStatus?.("building_outdated");
    await this.buildWithLock(local);
  }

  private warmupRetries = 0;
  private static readonly MAX_WARMUP_RETRIES = 3;

  warmup(reason: string): void {
    let local: ReturnType<typeof this.getLocalFingerprint>;
    try {
      local = this.getLocalFingerprint();
    } catch (err) {
      logger.warn({ err, reason }, "Edit image warmup skipped — failed to compute fingerprint");
      return;
    }
    if (this.inFlightBuild) return;

    this.imageFingerprint()
      .then((imageFingerprint) => {
        if (imageFingerprint === local.fingerprint) {
          this.readyFingerprint = local.fingerprint;
          logger.info({ reason }, "Edit image already up to date");
          return;
        }
        logger.info({ reason, imageFingerprint, localFingerprint: local.fingerprint }, "Edit image warmup starting build");
        return this.buildWithLock(local)
          .then(() => {
            this.warmupRetries = 0;
            logger.info({ reason }, "Edit image warmup completed");
          });
      })
      .catch(async (err) => {
        this.warmupRetries++;
        if (this.warmupRetries > EditImageBuilder.MAX_WARMUP_RETRIES) {
          logger.error({ err, reason, retries: this.warmupRetries }, "Edit image warmup failed — max retries reached, giving up");
          return;
        }
        // Try to free disk space before retrying
        try {
          await execFileAsync("docker", ["builder", "prune", "-f"], { timeout: 30_000 });
          logger.info("Pruned Docker build cache before edit image retry");
        } catch { /* best effort */ }
        logger.warn({ err, reason, retry: this.warmupRetries }, "Edit image warmup failed — scheduling retry in 60s");
        setTimeout(() => this.warmup(`${reason}_retry`), 60_000);
      });
  }
}

export const editImageBuilder = new EditImageBuilder();
