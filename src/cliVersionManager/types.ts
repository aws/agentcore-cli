import type { ProgressEvent } from "../tui/progress";

export type RegistryVersionFetcher = (distTag: string) => Promise<string>;

export type HttpFetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface CliVersionManager {
  /** Currently active CLI version. */
  getCurrentVersion(): string;

  /** Gets the latest version for the active dist-tag, using the cache when fresh. */
  getLatestVersion(options?: LatestVersionOptions): Promise<string>;

  /** Returns whether an update notice is due. */
  shouldShowUpdateNotice(): Promise<boolean>;

  /** Performs a live check and streams installation progress when an update is available. */
  update(): AsyncGenerator<ProgressEvent, UpdateResult>;
}

export type LatestVersionOptions = {
  /** Fetch the latest version without reading from the cache. */
  ignoreCache?: boolean;

  /** Maximum cache age in milliseconds. Defaults to one day. */
  maxAgeMs?: number;
};

export type UpdateStatus = "up-to-date" | "newer-local" | "updated";

export type UpdateResult = {
  status: UpdateStatus;
  currentVersion: string;
  latestVersion: string;
};

export type UpdateCheckStatus = Exclude<UpdateStatus, "updated"> | "update-available";

export type UpdateCheckResult = {
  status: UpdateCheckStatus;
  currentVersion: string;
  latestVersion: string;
};
