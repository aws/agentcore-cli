import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../logging";
import { createSilentLogger } from "../testing";
import { NpmCliVersionManager } from "./manager";
import { printUpdateNotice } from "./notice";

const INITIAL_TIME = new Date("2026-09-28T12:00:00.000Z");
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function createManagerFixture(
  options: {
    latestVersion?: string;
    cacheDirectory?: string;
    logger?: Logger;
    registryError?: Error;
  } = {},
) {
  let currentTime = INITIAL_TIME;
  let latestVersion = options.latestVersion ?? "1.1.0";
  const cacheDirectory =
    options.cacheDirectory ?? (await mkdtemp(join(tmpdir(), "agentcore-version-manager-")));
  tempDirectories.push(cacheDirectory);
  const manager = new NpmCliVersionManager({
    currentVersion: "1.0.0",
    cacheDirectory,
    logger: options.logger ?? createSilentLogger(),
    now: () => currentTime,
    registryVersionFetcher: async () => {
      if (options.registryError) throw options.registryError;
      return latestVersion;
    },
  });

  return {
    manager,
    setLatestVersion: (version: string) => {
      latestVersion = version;
    },
    setCurrentTime: (value: Date) => {
      currentTime = value;
    },
  };
}

describe("cache", () => {
  test("uses the cache until it is ignored or expired", async () => {
    const fixture = await createManagerFixture();

    expect(await fixture.manager.getLatestVersion()).toBe("1.1.0");
    fixture.setLatestVersion("1.2.0");
    expect(await fixture.manager.getLatestVersion()).toBe("1.1.0");
    expect(await fixture.manager.getLatestVersion({ ignoreCache: true })).toBe("1.2.0");

    fixture.setLatestVersion("1.3.0");
    fixture.setCurrentTime(new Date("2026-09-29T12:00:00.001Z"));
    expect(await fixture.manager.getLatestVersion()).toBe("1.3.0");
  });

  test("ignores a corrupt cache", async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), "agentcore-version-manager-"));
    await writeFile(join(cacheDirectory, "latest.json"), "not-json");
    const fixture = await createManagerFixture({ cacheDirectory });

    expect(await fixture.manager.getLatestVersion()).toBe("1.1.0");
  });
});

describe("update notices", () => {
  test.each([
    ["1.1.0", true],
    ["1.0.0", false],
  ] as const)("checks once per day when latest is %s", async (latestVersion, shouldNotify) => {
    const fixture = await createManagerFixture({ latestVersion });

    expect(await fixture.manager.shouldShowUpdateNotice()).toBe(shouldNotify);
    expect(await fixture.manager.shouldShowUpdateNotice()).toBe(false);

    fixture.setCurrentTime(new Date("2026-09-29T12:00:00.001Z"));
    expect(await fixture.manager.shouldShowUpdateNotice()).toBe(shouldNotify);
  });

  test("logs and suppresses failures", async () => {
    const logger = createSilentLogger();
    const warnings: string[] = [];
    logger.warn = (message) => warnings.push(message);
    const fixture = await createManagerFixture({
      logger,
      registryError: new Error("offline"),
    });

    await expect(fixture.manager.shouldShowUpdateNotice()).resolves.toBe(false);
    expect(warnings).toEqual(["failed to check for a CLI update"]);
  });

  test("prints an available update", async () => {
    const fixture = await createManagerFixture();
    const output: string[] = [];

    await printUpdateNotice(fixture.manager, { write: (text) => output.push(text) });

    expect(output.join("")).toBe(
      "\nUpdate available: 1.0.0 → 1.1.0\nRun `agentcore update` to update.\n",
    );
  });
});
