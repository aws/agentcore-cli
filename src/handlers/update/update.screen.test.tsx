import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupScreens,
  createSilentLogger,
  renderScreen,
  waitFor,
  waitForText,
} from "../../testing";
import { NpmCliVersionManager } from "../../cliVersionManager";
import { CliVersionManagerKey } from "../keys";

const tempDirectories: string[] = [];

afterEach(() => {
  cleanupScreens();
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createVersionManagerFixture(options: {
  versions?: Array<string | Promise<string>>;
  registryError?: Error;
  installation?: Promise<void>;
  installationError?: Error;
  installationOutput?: string[];
}) {
  const cacheDirectory = mkdtempSync(join(tmpdir(), "agentcore-update-screen-"));
  tempDirectories.push(cacheDirectory);
  const registryVersions = [...(options.versions ?? ["1.0.0"])];
  const invocationCounts = { registry: 0, installation: 0 };
  return {
    invocationCounts,
    versionManager: new NpmCliVersionManager({
      currentVersion: "1.0.0",
      cacheDirectory,
      logger: createSilentLogger(),
      registryVersionFetcher: async () => {
        invocationCounts.registry += 1;
        if (options.registryError) throw options.registryError;
        return await (registryVersions.shift() ?? "1.0.0");
      },
      processStreamer: async function* () {
        invocationCounts.installation += 1;
        for (const line of options.installationOutput ?? []) {
          yield { type: "stdout" as const, line };
        }
        await options.installation;
        if (options.installationError) throw options.installationError;
      },
    }),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function renderUpdateScreen(path: string, versionManager: NpmCliVersionManager) {
  return renderScreen(path, {
    withContext: (ctx) => ctx.withValue(CliVersionManagerKey, versionManager),
  });
}

test("shows the current version while checking", async () => {
  const latestVersion = deferred<string>();
  const fixture = createVersionManagerFixture({ versions: [latestVersion.promise] });
  const screen = renderUpdateScreen("/agentcore", fixture.versionManager);

  await waitForText(screen.lastFrame, "v1.0.0");
  expect(screen.lastFrame()).not.toContain("update available");

  latestVersion.resolve("1.0.0");
  await waitFor(() => fixture.invocationCounts.registry === 1);
  screen.unmount();
});

test("shows the checking state on the update screen", async () => {
  const latestVersion = deferred<string>();
  const fixture = createVersionManagerFixture({ versions: [latestVersion.promise] });
  const screen = renderUpdateScreen("/agentcore/update", fixture.versionManager);

  await waitForText(screen.lastFrame, "checking for updates…");
  latestVersion.resolve("1.0.0");
  await waitForText(screen.lastFrame, "AgentCore 1.0.0 is up to date.");
  screen.unmount();
});

test("shows an available update", async () => {
  const fixture = createVersionManagerFixture({ versions: ["1.1.0"] });
  const screen = renderUpdateScreen("/agentcore", fixture.versionManager);

  await waitForText(screen.lastFrame, "v1.0.0 • update available");
  expect(screen.lastFrame()).toContain("check for and install CLI updates");
  expect(screen.lastFrame()).toContain("update to install 1.1.0");
  screen.unmount();
});

test("keeps the current version when the registry is unavailable", async () => {
  const fixture = createVersionManagerFixture({ registryError: new Error("offline") });
  const screen = renderUpdateScreen("/agentcore", fixture.versionManager);

  await waitFor(() => fixture.invocationCounts.registry === 1);
  expect(screen.lastFrame()).toContain("v1.0.0");
  expect(screen.lastFrame()).not.toContain("offline");
  screen.unmount();
});

test("shows a registry failure on the update screen", async () => {
  const fixture = createVersionManagerFixture({ registryError: new Error("offline") });
  const screen = renderUpdateScreen("/agentcore/update", fixture.versionManager);

  await waitForText(screen.lastFrame, "Unable to check for updates. Current version: 1.0.0");
  await screen.press("escape");
  await waitFor(() => !screen.lastFrame()?.includes("Unable to check for updates"));
  screen.unmount();
});

test.each([
  ["1.0.0", "AgentCore is up to date"],
  ["0.9.0", "Local AgentCore is newer"],
] as const)(
  "shows %s if the registry changes before installation",
  async (latestVersion, title) => {
    const fixture = createVersionManagerFixture({ versions: ["1.1.0", latestVersion] });
    const screen = renderUpdateScreen("/agentcore/update", fixture.versionManager);

    await waitForText(screen.lastFrame, "Update AgentCore from 1.0.0 to 1.1.0?");
    await screen.write("y");
    await waitForText(screen.lastFrame, title);
    expect(fixture.invocationCounts.installation).toBe(0);
    screen.unmount();
  },
);

test("navigates through the menu, confirms, and shows update progress", async () => {
  const installation = deferred<void>();
  const fixture = createVersionManagerFixture({
    versions: ["1.1.0", "1.1.0"],
    installation: installation.promise,
    installationOutput: ["installing @aws/agentcore"],
  });
  const screen = renderUpdateScreen("/agentcore", fixture.versionManager);

  await waitForText(screen.lastFrame, "v1.0.0 • update available");
  await waitForText(screen.lastFrame, "update to install 1.1.0");
  await screen.write("update");
  await screen.press("return");
  await waitForText(screen.lastFrame, "Update AgentCore from 1.0.0 to 1.1.0?");
  expect(fixture.invocationCounts.installation).toBe(0);

  await screen.write("y");
  await waitForText(screen.lastFrame, "Updating AgentCore");
  await waitForText(screen.lastFrame, "installing @aws/agentcore");
  await waitFor(() => fixture.invocationCounts.installation === 1);

  installation.resolve();
  await waitForText(screen.lastFrame, "AgentCore updated");
  expect(screen.lastFrame()).toContain("Restart AgentCore to use the new version.");
  expect(screen.lastFrame()).toContain("enter");
  expect(screen.lastFrame()).toContain("exit");
  screen.unmount();
});

test("shows update failures", async () => {
  const fixture = createVersionManagerFixture({
    versions: ["1.1.0", "1.1.0"],
    installationError: new Error("npm failed"),
  });
  const screen = renderUpdateScreen("/agentcore/update", fixture.versionManager);

  await waitForText(screen.lastFrame, "Update AgentCore from 1.0.0 to 1.1.0?");
  await screen.write("y");
  await waitForText(screen.lastFrame, "npm failed");
  expect(screen.lastFrame()).toContain("Updating AgentCore");
  screen.unmount();
});
