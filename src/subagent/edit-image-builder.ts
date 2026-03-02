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
    const dockerfilePath = `${localAppDir}/docker/subagent-edit.Dockerfile`;
    const versionFilePath = `${localAppDir}/.rick-version`;
    const packageJsonPath = `${localAppDir}/package.json`;

    const hash = createHash("sha256")
      .update(readFileSync(editAgentPath))
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
        "--no-cache",
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

  warmup(reason: string): void {
    const local = this.getLocalFingerprint();
    if (this.inFlightBuild) return;

    this.imageFingerprint()
      .then((imageFingerprint) => {
        if (imageFingerprint === local.fingerprint) {
          this.readyFingerprint = local.fingerprint;
          return;
        }
        return this.buildWithLock(local)
          .then(() => logger.info({ reason }, "Edit image warmup completed"));
      })
      .catch((err) => logger.warn({ err, reason }, "Edit image warmup failed"));
  }
}

export const editImageBuilder = new EditImageBuilder();
