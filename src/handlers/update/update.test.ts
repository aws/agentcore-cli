import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNpmRegistryVersionFetcher,
  NpmCliVersionManager,
} from "../../cliVersionManager/manager";
import type { HttpFetcher } from "../../cliVersionManager/types";
import { NetworkingError } from "../../errors";
import type { ProcessStreamer } from "../../io";
import { ValueContext } from "../../router";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
  ttyTestIO,
  type TestIO,
} from "../../testing";
import { createRootHandler } from "../index";
import { CliVersionManagerKey } from "../keys";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function runUpdateCommand(
  args: string[],
  options: {
    currentVersion?: string;
    latestVersion?: string;
    fetcher?: HttpFetcher;
    processStreamer?: ProcessStreamer;
    io?: TestIO;
  } = {},
) {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "agentcore-update-handler-"));
  tempDirectories.push(cacheDirectory);
  const io = options.io ?? testIO();
  const registryRequests: string[] = [];
  const processCalls: string[][] = [];
  const versionManager = new NpmCliVersionManager({
    currentVersion: options.currentVersion ?? "1.0.0",
    cacheDirectory,
    logger: createSilentLogger(),
    registryVersionFetcher: createNpmRegistryVersionFetcher(async (input, init) => {
      registryRequests.push(String(input));
      return options.fetcher
        ? options.fetcher(input, init)
        : new Response(JSON.stringify({ version: options.latestVersion ?? "1.1.0" }));
    }),
    processStreamer: async function* (command, processOptions) {
      processCalls.push(command);
      if (options.processStreamer) {
        yield* options.processStreamer(command, processOptions);
      }
    },
  });
  const root = createRootHandler(new TestCoreClient(), {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });

  await root.route(
    ["node", "agentcore", "update", ...args],
    ValueContext.EmptyContext().withValue(CliVersionManagerKey, versionManager),
  );

  return { output: JSON.parse(io.stdout()), stderr: io.stderr(), registryRequests, processCalls };
}

test.each([
  ["check reports an available update", ["--check"], "1.1.0", "update-available", false],
  ["check reports the current version", ["--check"], "1.0.0", "up-to-date", false],
  ["check reports a newer local version", ["--check"], "0.9.0", "newer-local", false],
  ["update installs an available version", [], "1.1.0", "updated", true],
  ["update does nothing when current", [], "1.0.0", "up-to-date", false],
  ["update does not downgrade", [], "0.9.0", "newer-local", false],
] as const)("%s", async (_label, args, latestVersion, status, shouldInstall) => {
  const commandResult = await runUpdateCommand([...args], { latestVersion });

  expect(commandResult.output).toEqual({
    status,
    currentVersion: "1.0.0",
    latestVersion,
  });
  expect(commandResult.processCalls).toEqual(
    shouldInstall
      ? [["npm", "install", "-g", `@aws/agentcore@${latestVersion}`, "--loglevel=http"]]
      : [],
  );
});

test("updates between versions on the same prerelease channel", async () => {
  const commandResult = await runUpdateCommand([], {
    currentVersion: "1.0.0-rc.3",
    latestVersion: "1.0.0-rc.4",
  });

  expect(commandResult.output).toEqual({
    status: "updated",
    currentVersion: "1.0.0-rc.3",
    latestVersion: "1.0.0-rc.4",
  });
  expect(commandResult.processCalls).toEqual([
    ["npm", "install", "-g", "@aws/agentcore@1.0.0-rc.4", "--loglevel=http"],
  ]);
});

test.each([
  ["1.0.0", "latest"],
  ["1.0.0-rc.1", "rc"],
  ["1.0.0-preview.1", "preview"],
])("checks the %s version's %s channel", async (currentVersion, distTag) => {
  const commandResult = await runUpdateCommand(["--check"], {
    currentVersion,
    latestVersion: currentVersion,
  });
  expect(commandResult.registryRequests).toEqual([
    `https://registry.npmjs.org/@aws/agentcore/${distTag}`,
  ]);
});

test.each([
  ["a network failure", async () => Promise.reject(new TypeError("offline"))],
  ["an invalid response", async () => new Response("{}")],
])("reports %s as a networking error", async (_label, fetcher) => {
  await expect(
    runUpdateCommand(["--check"], {
      fetcher,
    }),
  ).rejects.toBeInstanceOf(NetworkingError);
});

test("reports install failures", async () => {
  const io = ttyTestIO().streams;

  await expect(
    runUpdateCommand([], {
      io,
      processStreamer: async function* () {
        yield { type: "stderr", line: "npm failed" };
        throw new Error("npm failed");
      },
    }),
  ).rejects.toThrow("npm failed");

  expect(io.stderr()).toContain("npm failed");
});
