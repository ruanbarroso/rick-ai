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
    const dockerfilePath = `${localAppDir}/docker/subagent.Dockerfile`;
    const versionFilePath = `${localAppDir}/.rick-version`;
    const packageJsonPath = `${localAppDir}/package.json`;

    const hash = createHash("sha256")
      .update(readFileSync(agentMjsPath))
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

  private async imageFingerprint(imageRef: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync("docker", [
        "inspect",
        "--format",
        "{{index .Config.Labels \"agent.bundle.hash\"}}|{{index .Config.Labels \"rick.version\"}}",
        imageRef,
      ], { timeout: 10_000 });
      const out = stdout.trim();
      return out || null;
    } catch {
      return null;
    }
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

    const currentFingerprint = await this.imageFingerprint(CURRENT_IMAGE);
    const hasCurrent = currentFingerprint !== null || await this.imageExists(CURRENT_IMAGE);

    if (currentFingerprint === local.fingerprint) {
      this.readyFingerprint = local.fingerprint;
      return CURRENT_IMAGE;
    }

    if (currentFingerprint) {
      const [imageHash = "", imageVersion = ""] = currentFingerprint.split("|");
      logger.info(
        {
          localHash: local.hash,
          imageHash: imageHash || "(none)",
          localVersion: local.version,
          imageVersion: imageVersion || "(none)",
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
      .then((fp) => {
        if (fp === local.fingerprint) {
          this.readyFingerprint = local.fingerprint;
          logger.info({ reason }, "Subagent image already up to date");
          return;
        }
        logger.info({ reason, imageFingerprint: fp, localFingerprint: local.fingerprint }, "Subagent image warmup starting build");
        return this.startBackgroundBuild(local, reason);
      })
      .catch((err) => {
        logger.warn({ err, reason }, "Subagent image warmup failed — scheduling retry in 60s");
        setTimeout(() => this.warmup(`${reason}_retry`), 60_000);
      });
  }
}

export const subagentImageBuilder = new SubagentImageBuilder();
