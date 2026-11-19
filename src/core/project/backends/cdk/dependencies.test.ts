import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProjectEvent } from "../../../../handlers/project/types";
import { ProcessFailedError, type ProcessRunner } from "../../../../io";
import { createSilentLogger } from "../../../../testing";
import { planDependencySync, syncCdkDependencies } from "./dependencies";

const VENDED = {
  devDependencies: { "aws-cdk": "~2.1126.0", typescript: "~5.9.3" },
  dependencies: { "@aws/agentcore-cdk": "1.1.0", "aws-cdk-lib": "~2.269.0" },
};

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function cdkDirectoryWith(manifest: object, installed = true): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-cdk-dependencies-"));
  tempDirectories.push(directory);
  await writeFile(join(directory, "package.json"), JSON.stringify(manifest, undefined, 2));
  if (installed) await mkdir(join(directory, "node_modules"));
  return directory;
}

async function run(
  cdkDirectory: string,
  options: { runner?: ProcessRunner; disabled?: boolean; lenient?: boolean } = {},
) {
  const commands: string[][] = [];
  const events: ProjectEvent[] = [];
  const runner: ProcessRunner =
    options.runner ??
    (async (command) => {
      commands.push(command);
    });
  for await (const event of syncCdkDependencies({
    cdkDirectory,
    vendedManifest: JSON.stringify(VENDED),
    runner,
    logger: createSilentLogger(),
    disabled: options.disabled,
    lenient: options.lenient,
  })) {
    events.push(event);
  }
  const manifest = JSON.parse(await readFile(join(cdkDirectory, "package.json"), "utf8"));
  return { commands, events, manifest };
}

describe("planDependencySync", () => {
  test("moves an older exact L3 pin and an older tilde minor to the vended specifiers", () => {
    const plan = planDependencySync(VENDED, {
      devDependencies: VENDED.devDependencies,
      dependencies: { "@aws/agentcore-cdk": "1.0.3", "aws-cdk-lib": "~2.260.0" },
    });

    expect(plan.changes).toEqual([
      { name: "@aws/agentcore-cdk", section: "dependencies", from: "1.0.3", to: "1.1.0" },
      { name: "aws-cdk-lib", section: "dependencies", from: "~2.260.0", to: "~2.269.0" },
    ]);
    expect(plan.newer).toEqual([]);
  });

  test("migrates caret ranges and restores a managed dependency the user deleted", () => {
    const plan = planDependencySync(VENDED, {
      devDependencies: { "aws-cdk": "^2.1000.0" },
      dependencies: VENDED.dependencies,
    });

    expect(plan.changes).toEqual([
      { name: "aws-cdk", section: "devDependencies", from: "^2.1000.0", to: "~2.1126.0" },
      { name: "typescript", section: "devDependencies", to: "~5.9.3" },
    ]);
  });

  test("reports pins a newer CLI wrote instead of downgrading them", () => {
    const plan = planDependencySync(VENDED, {
      devDependencies: { "aws-cdk": "~2.1126.9", typescript: "~5.9.3" },
      dependencies: { "@aws/agentcore-cdk": "1.2.0", "aws-cdk-lib": "~2.270.0" },
    });

    // A newer patch on a tilde range is inside what the range allows, so it is not newer.
    expect(plan.changes).toEqual([
      { name: "aws-cdk", section: "devDependencies", from: "~2.1126.9", to: "~2.1126.0" },
    ]);
    expect(plan.newer.map(({ name }) => name)).toEqual(["@aws/agentcore-cdk", "aws-cdk-lib"]);
  });

  test("leaves non-version specifiers and the user's own dependencies alone", () => {
    const plan = planDependencySync(VENDED, {
      devDependencies: VENDED.devDependencies,
      dependencies: {
        "@aws/agentcore-cdk": "file:../agentcore-cdk.tgz",
        "aws-cdk-lib": "~2.269.0",
        "my-construct": "^3.0.0",
      },
    });

    expect(plan.changes).toEqual([]);
    expect(plan.skipped).toEqual([
      { name: "@aws/agentcore-cdk", declared: "file:../agentcore-cdk.tgz" },
    ]);
  });
});

describe("syncCdkDependencies", () => {
  test("rewrites only managed entries and installs once", async () => {
    const directory = await cdkDirectoryWith({
      name: "agentcore-cdk-app",
      devDependencies: VENDED.devDependencies,
      dependencies: { "@aws/agentcore-cdk": "1.0.3", "aws-cdk-lib": "~2.269.0", zod: "4.1.0" },
    });

    const { commands, events, manifest } = await run(directory);

    expect(manifest.dependencies).toEqual({
      "@aws/agentcore-cdk": "1.1.0",
      "aws-cdk-lib": "~2.269.0",
      zod: "4.1.0",
    });
    expect(manifest.name).toBe("agentcore-cdk-app");
    expect(commands).toEqual([["npm", "install"]]);
    expect(events).toContainEqual({
      type: "step",
      message: "updating CDK dependencies: @aws/agentcore-cdk 1.0.3 -> 1.1.0",
    });
  });

  test("does nothing when the pins already match", async () => {
    const directory = await cdkDirectoryWith(VENDED);

    const { commands, events } = await run(directory);

    expect(commands).toEqual([]);
    expect(events).toEqual([]);
  });

  test("installs a missing node_modules even when the pins already match", async () => {
    const directory = await cdkDirectoryWith(VENDED, false);

    const { commands, events, manifest } = await run(directory);

    expect(manifest).toEqual(VENDED);
    expect(commands).toEqual([["npm", "install"]]);
    expect(events).toEqual([
      { type: "step", message: "installing CDK dependencies (node_modules missing)" },
    ]);
  });

  test("names the directory and npm's error when installing a missing node_modules fails", async () => {
    const directory = await cdkDirectoryWith(VENDED, false);
    const failure = new ProcessFailedError(["npm", "install"], directory, 1, "npm error E404");
    const runner: ProcessRunner = async () => {
      throw failure;
    };

    await expect(run(directory, { runner })).rejects.toThrow(
      new RegExp(`npm install failed in ${directory}.*npm error E404`, "s"),
    );
    const { events } = await run(directory, { runner, lenient: true });
    expect(events.at(-1)).toEqual({
      type: "warning",
      message: expect.stringContaining("npm error E404"),
    });
  });

  test("does nothing when the project has no CDK package.json", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentcore-cdk-dependencies-"));
    tempDirectories.push(directory);
    const commands: string[][] = [];

    const events: ProjectEvent[] = [];
    for await (const event of syncCdkDependencies({
      cdkDirectory: directory,
      vendedManifest: JSON.stringify(VENDED),
      runner: async (command) => {
        commands.push(command);
      },
      logger: createSilentLogger(),
    })) {
      events.push(event);
    }

    expect(commands).toEqual([]);
    expect(events).toEqual([]);
  });

  test("fails on a pin newer than this CLI, naming the dependency and the opt-out", async () => {
    const directory = await cdkDirectoryWith({
      ...VENDED,
      dependencies: { ...VENDED.dependencies, "@aws/agentcore-cdk": "1.2.0" },
    });

    await expect(run(directory)).rejects.toThrow(
      /@aws\/agentcore-cdk 1\.2\.0 \(this CLI expects 1\.1\.0\).*disableDependencyManagement/s,
    );
  });

  test("only warns about a newer pin when the user opted out, and writes nothing", async () => {
    const original = {
      ...VENDED,
      dependencies: { "@aws/agentcore-cdk": "1.2.0", "aws-cdk-lib": "~2.200.0" },
    };
    const directory = await cdkDirectoryWith(original);

    const { commands, events, manifest } = await run(directory, { disabled: true });

    expect(manifest).toEqual(original);
    expect(commands).toEqual([]);
    expect(events.map(({ type }) => type)).toEqual(["warning"]);
  });

  test("only warns about a newer pin on a teardown, and still syncs the rest", async () => {
    const directory = await cdkDirectoryWith({
      ...VENDED,
      dependencies: { "@aws/agentcore-cdk": "1.2.0", "aws-cdk-lib": "~2.200.0" },
    });

    const { commands, events, manifest } = await run(directory, { lenient: true });

    expect(manifest.dependencies["aws-cdk-lib"]).toBe("~2.269.0");
    expect(manifest.dependencies["@aws/agentcore-cdk"]).toBe("1.2.0");
    expect(commands).toEqual([["npm", "install"]]);
    expect(events[0]?.type).toBe("warning");
  });

  test("restores package.json when npm install fails, so the next run retries", async () => {
    const original = {
      ...VENDED,
      dependencies: { ...VENDED.dependencies, "aws-cdk-lib": "^2.1.0" },
    };
    const directory = await cdkDirectoryWith(original);
    const before = await readFile(join(directory, "package.json"), "utf8");
    const failure = new ProcessFailedError(["npm", "install"], directory, 1, "E404");

    await expect(
      run(directory, {
        runner: async () => {
          throw failure;
        },
      }),
    ).rejects.toThrow(/npm install failed in .*E404/s);
    expect(await readFile(join(directory, "package.json"), "utf8")).toBe(before);
  });
});
