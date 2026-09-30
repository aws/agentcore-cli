import { join } from "node:path";
import semver from "semver";
import z from "zod";
import { AgentCoreCLIError, NetworkingError } from "../errors";
import { FsReadWriteJson, streamProcess, type ProcessStreamer, type ReadWriteJson } from "../io";
import type { Logger } from "../logging";
import type { ProgressEvent } from "../tui/progress";
import {
  type CliVersionManager,
  type HttpFetcher,
  type LatestVersionOptions,
  type RegistryVersionFetcher,
  type UpdateResult,
} from "./types";

const PACKAGE_NAME = "@aws/agentcore";
const REGISTRY_URL = "https://registry.npmjs.org";
const REGISTRY_TIMEOUT_MS = 2000;
const DEFAULT_UPDATE_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const cachedVersionSchema = z.object({
  latestVersion: z.string().refine((version) => semver.valid(version) !== null),
  lastCheckedAt: z.iso.datetime(),
});
const registryVersionSchema = z.object({ version: z.string() });

type CachedVersion = z.infer<typeof cachedVersionSchema>;

export type NpmCliVersionManagerConfig = {
  currentVersion: string;
  cacheDirectory: string;
  logger: Logger;
  registryVersionFetcher?: RegistryVersionFetcher;
  processStreamer?: ProcessStreamer;
  json?: ReadWriteJson;
  now?: () => Date;
  cwd?: () => string;
};

export class NpmCliVersionManager implements CliVersionManager {
  private readonly registryVersionFetcher: RegistryVersionFetcher;
  private readonly processStreamer: ProcessStreamer;
  private readonly json: ReadWriteJson;
  private readonly now: () => Date;
  private readonly cwd: () => string;

  constructor(private readonly config: NpmCliVersionManagerConfig) {
    this.registryVersionFetcher =
      config.registryVersionFetcher ?? createNpmRegistryVersionFetcher();
    this.processStreamer = config.processStreamer ?? streamProcess;
    this.json = config.json ?? new FsReadWriteJson({ logger: config.logger });
    this.now = config.now ?? (() => new Date());
    this.cwd = config.cwd ?? process.cwd;
  }

  getCurrentVersion(): string {
    return this.config.currentVersion;
  }

  async getLatestVersion(options: LatestVersionOptions = {}): Promise<string> {
    const maxAgeMs = options.maxAgeMs ?? DEFAULT_UPDATE_CACHE_MAX_AGE_MS;
    if (!options.ignoreCache) {
      const cachedVersion = await this.readCachedVersion();
      if (cachedVersion && this.isCachedVersionFresh(cachedVersion, maxAgeMs)) {
        return cachedVersion.latestVersion;
      }
    }

    const latestVersion = await this.fetchLatestVersion();
    await this.writeCachedVersion(latestVersion);
    return latestVersion;
  }

  async shouldShowUpdateNotice(): Promise<boolean> {
    const cachedVersion = await this.readCachedVersion();
    if (
      cachedVersion &&
      this.isCachedVersionFresh(cachedVersion, DEFAULT_UPDATE_CACHE_MAX_AGE_MS)
    ) {
      return false;
    }

    try {
      const latestVersion = await this.fetchLatestVersion();
      if (!(await this.writeCachedVersion(latestVersion))) return false;
      return semver.gt(latestVersion, this.getCurrentVersion());
    } catch (cause) {
      this.logFailure("failed to check for a CLI update", cause);
      return false;
    }
  }

  async *update(): AsyncGenerator<ProgressEvent, UpdateResult> {
    const latestVersion = await this.fetchLatestVersion();
    await this.writeCachedVersion(latestVersion);
    const currentVersion = this.getCurrentVersion();
    const versionComparison = semver.compare(latestVersion, currentVersion);

    if (versionComparison === 0) return { status: "up-to-date", currentVersion, latestVersion };
    if (versionComparison < 0) return { status: "newer-local", currentVersion, latestVersion };

    yield { type: "step", message: "Updating AgentCore" };
    for await (const processEvent of this.processStreamer(
      ["npm", "install", "-g", `${PACKAGE_NAME}@${latestVersion}`, "--loglevel=http"],
      { cwd: this.cwd() },
    )) {
      yield { type: "output", line: processEvent.line };
    }
    return { status: "updated", currentVersion, latestVersion };
  }

  private async fetchLatestVersion(): Promise<string> {
    const latestVersion = await this.registryVersionFetcher(distTag(this.getCurrentVersion()));
    if (!semver.valid(latestVersion)) {
      throw new NetworkingError(`npm returned an invalid version: ${latestVersion}`);
    }
    return latestVersion;
  }

  private async readCachedVersion(): Promise<CachedVersion | undefined> {
    try {
      return await this.json.read(this.cachedVersionPath(), cachedVersionSchema);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logFailure("failed to read the CLI update cache", cause);
      }
      return undefined;
    }
  }

  private async writeCachedVersion(latestVersion: string): Promise<boolean> {
    try {
      await this.json.write(this.cachedVersionPath(), {
        latestVersion,
        lastCheckedAt: this.now().toISOString(),
      } satisfies CachedVersion);
      return true;
    } catch (cause) {
      this.logFailure("failed to write the CLI update cache", cause);
      return false;
    }
  }

  private isCachedVersionFresh(cachedVersion: CachedVersion, maxAgeMs: number): boolean {
    const cachedVersionAgeMs = this.now().getTime() - Date.parse(cachedVersion.lastCheckedAt);
    return cachedVersionAgeMs >= 0 && cachedVersionAgeMs <= maxAgeMs;
  }

  private cachedVersionPath(): string {
    return join(this.config.cacheDirectory, `${safeDistTag(this.getCurrentVersion())}.json`);
  }

  private logFailure(message: string, cause: unknown): void {
    const cliError = AgentCoreCLIError.fromError(cause);
    this.config.logger
      .child({ errorName: cliError.name, errorMessage: cliError.message })
      .warn(message);
  }
}

function distTag(version: string): string {
  if (!semver.valid(version)) {
    throw new AgentCoreCLIError(`invalid CLI version: ${version}`, { meta: { version } });
  }
  return semver.prerelease(version)?.[0]?.toString() ?? "latest";
}

function safeDistTag(version: string): string {
  const distTagName = distTag(version);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(distTagName)) {
    throw new AgentCoreCLIError(`unsafe npm dist-tag: ${distTagName}`, {
      meta: { tag: distTagName },
    });
  }
  return distTagName;
}

export function createNpmRegistryVersionFetcher(
  fetcher: HttpFetcher = globalThis.fetch,
  timeoutMs = REGISTRY_TIMEOUT_MS,
): RegistryVersionFetcher {
  return async (distTagName) => {
    try {
      const registryResponse = await fetcher(`${REGISTRY_URL}/${PACKAGE_NAME}/${distTagName}`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!registryResponse.ok) {
        throw new NetworkingError(`Failed to fetch latest version: ${registryResponse.statusText}`);
      }
      return registryVersionSchema.parse(await registryResponse.json()).version;
    } catch (cause) {
      throw new NetworkingError("Failed to fetch latest version from npm", { cause });
    }
  };
}
