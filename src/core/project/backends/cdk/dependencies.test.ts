import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProjectEvent } from "../../../../handlers/project/types";
import { FsReadWriteJson, ProcessFailedError, type ProcessRunner } from "../../../../io";
import { createSilentLogger } from "../../../../testing";
import { ProjectStateError } from "../../../../errors/errors";
import { newerPinMessage, planDependencySync, syncCdkDependencies } from "./dependencies";

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

/** A CDK directory whose package.json is `manifest`, with `installed` as the installed L3 (null: none). */
async function cdkDirectoryWith(
  manifest: object | string,
  installed: string | null = VENDED.dependencies["@aws/agentcore-cdk"],
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-cdk-dependencies-"));
  tempDirectories.push(directory);
  await writeFile(
    join(directory, "package.json"),
    typeof manifest === "string" ? manifest : JSON.stringify(manifest, undefined, 2),
  );
  if (installed) await installL3(directory, installed);
  return directory;
}

async function installL3(directory: string, version: string): Promise<void> {
  const library = join(directory, "node_modules", "@aws", "agentcore-cdk");
  await mkdir(library, { recursive: true });
  await writeFile(join(library, "package.json"), JSON.stringify({ version }));
}

async function run(
  cdkDirectory: string,
  options: { runner?: ProcessRunner; lenient?: boolean; disabled?: boolean } = {},
): Promise<{ events: ProjectEvent[]; installs: number }> {
  const events: ProjectEvent[] = [];
  let installs = 0;
  for await (const event of syncCdkDependencies({
    cdkDirectory,
    vendedManifest: JSON.stringify(VENDED),
    json: new FsReadWriteJson({ logger: createSilentLogger() }),
    runner:
      options.runner ??
      (async () => {
        installs++;
      }),
    logger: createSilentLogger(),
    lenient: options.lenient,
    disabled: options.disabled,
  })) {
    events.push(event);
  }
  return { events, installs };
}

const manifestOf = (directory: string) => readFile(join(directory, "package.json"), "utf8");

describe("planDependencySync", () => {
  test("moves an older exact L3 pin and older tilde pins to the vended specifiers", () => {
    const plan = planDependencySync(VENDED, {
      devDependencies: { "aws-cdk": "~2.1126.0", typescript: "~5.9.2" },
      dependencies: { "@aws/agentcore-cdk": "1.0.3", "aws-cdk-lib": "~2.260.0" },
    });

    expect(plan.changes).toEqual([
      { name: "@aws/agentcore-cdk", section: "dependencies", from: "1.0.3", to: "1.1.0" },
      { name: "aws-cdk-lib", section: "dependencies", from: "~2.260.0", to: "~2.269.0" },
      { name: "typescript", section: "devDependencies", from: "~5.9.2", to: "~5.9.3" },
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

    // A higher patch on a tilde range is inside the vended range, so it is left alone.
    expect(plan.changes).toEqual([]);
    expect(plan.newer.map(({ name }) => name)).toEqual(["@aws/agentcore-cdk", "aws-cdk-lib"]);
  });

  test("leaves non-version specifiers and the user's own dependencies alone", () => {
    const plan = planDependencySync(VENDED, {
      devDependencies: VENDED.devDependencies,
      dependencies: {
        "@aws/agentcore-cdk": "file:../agentcore-cdk.tgz",
        "aws-cdk-lib": ">=2.200.0",
        "my-construct": "^3.0.0",
      },
    });

    expect(plan.changes).toEqual([]);
    expect(plan.skipped).toEqual([
      { name: "@aws/agentcore-cdk", declared: "file:../agentcore-cdk.tgz" },
      { name: "aws-cdk-lib", declared: ">=2.200.0" },
    ]);
  });
});

describe("newerPinMessage", () => {
  test("names only the L3 pin when it is newer, since the update fixes the rest", () => {
    expect(
      newerPinMessage([
        { name: "typescript", declared: "~6.0.0", expected: "~5.9.3" },
        { name: "@aws/agentcore-cdk", declared: "1.2.0", expected: "1.1.0" },
      ]),
    ).toBe(
      "agentcore/cdk/package.json pins @aws/agentcore-cdk 1.2.0, newer than the version this " +
        "CLI vends (1.1.0). Run 'agentcore update', or run 'agentcore config " +
        "disableDependencyManagement true' to manage the CDK dependencies yourself.",
    );
  });

  test("gives one sentence per newer toolchain pin", () => {
    expect(
      newerPinMessage([
        { name: "typescript", declared: "~6.0.0", expected: "~5.9.3" },
        { name: "aws-cdk-lib", declared: "~2.270.0", expected: "~2.269.0" },
      ]),
    ).toBe(
      "agentcore/cdk/package.json pins typescript ~6.0.0, newer than the version this CLI " +
        "vends (~5.9.3). agentcore/cdk/package.json pins aws-cdk-lib ~2.270.0, newer than the " +
        "version this CLI vends (~2.269.0). Run 'agentcore update', or run 'agentcore config " +
        "disableDependencyManagement true' to manage the CDK dependencies yourself.",
    );
  });
});

describe("syncCdkDependencies", () => {
  test("does nothing when the pins match and the pinned L3 is installed", async () => {
    const directory = await cdkDirectoryWith(VENDED);

    expect(await run(directory)).toEqual({ events: [], installs: 0 });
  });

  test("installs when the manifest matches but an older L3 is installed", async () => {
    const directory = await cdkDirectoryWith(VENDED, "1.0.3");

    const { events, installs } = await run(directory);

    expect(installs).toBe(1);
    expect(events[0]).toEqual({
      type: "step",
      message:
        "installing CDK dependencies (@aws/agentcore-cdk 1.0.3 is installed, " +
        "agentcore/cdk/package.json pins 1.1.0)",
    });
  });

  test("installs when node_modules is missing", async () => {
    const directory = await cdkDirectoryWith(VENDED, null);

    expect((await run(directory)).installs).toBe(1);
  });

  test("retries the install on the next run after an interrupted one", async () => {
    const directory = await cdkDirectoryWith(
      { ...VENDED, dependencies: { ...VENDED.dependencies, "@aws/agentcore-cdk": "1.0.3" } },
      "1.0.3",
    );
    const interrupted = new ProcessFailedError(["npm", "install"], directory, 130, "");

    await expect(
      run(directory, {
        runner: async () => {
          throw interrupted;
        },
      }),
    ).rejects.toBe(interrupted);
    expect(JSON.parse(await manifestOf(directory)).dependencies["@aws/agentcore-cdk"]).toBe(
      "1.1.0",
    );

    expect((await run(directory)).installs).toBe(1);
  });

  test("rethrows npm's failure, or warns with it when lenient", async () => {
    const directory = await cdkDirectoryWith(VENDED, null);
    const failure = new ProcessFailedError(["npm", "install"], directory, 1, "npm error E404");
    const runner: ProcessRunner = async () => {
      throw failure;
    };

    await expect(run(directory, { runner })).rejects.toBe(failure);
    const { events } = await run(directory, { runner, lenient: true });
    expect(events.at(-1)).toEqual({ type: "warning", message: failure.message });
  });

  test("does nothing when the project has no CDK package.json", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentcore-cdk-dependencies-"));
    tempDirectories.push(directory);

    expect(await run(directory)).toEqual({ events: [], installs: 0 });
  });

  test("fails on an L3 library newer than this CLI vends, leaving package.json alone", async () => {
    const directory = await cdkDirectoryWith({
      ...VENDED,
      dependencies: { ...VENDED.dependencies, "@aws/agentcore-cdk": "1.2.0" },
    });
    const before = await manifestOf(directory);

    await expect(run(directory)).rejects.toThrow(
      newerPinMessage([{ name: "@aws/agentcore-cdk", declared: "1.2.0", expected: "1.1.0" }]),
    );
    expect(await manifestOf(directory)).toBe(before);
  });

  test("fails on a newer toolchain pin", async () => {
    const directory = await cdkDirectoryWith({
      ...VENDED,
      dependencies: { ...VENDED.dependencies, "aws-cdk-lib": "~2.270.0" },
    });

    await expect(run(directory)).rejects.toThrow(
      "agentcore/cdk/package.json pins aws-cdk-lib ~2.270.0, newer than the version this CLI " +
        "vends (~2.269.0).",
    );
  });

  test("says nothing about a newer pin when dependency management is disabled", async () => {
    const directory = await cdkDirectoryWith({
      ...VENDED,
      dependencies: { ...VENDED.dependencies, "@aws/agentcore-cdk": "1.2.0" },
    });

    expect(await run(directory, { disabled: true })).toEqual({ events: [], installs: 0 });
  });

  test("warns about an older L3 pin when dependency management is disabled", async () => {
    const directory = await cdkDirectoryWith(
      { ...VENDED, dependencies: { ...VENDED.dependencies, "@aws/agentcore-cdk": "1.0.3" } },
      "1.0.3",
    );
    const before = await manifestOf(directory);

    expect(await run(directory, { disabled: true })).toEqual({
      events: [
        {
          type: "warning",
          message:
            "agentcore/cdk/package.json pins @aws/agentcore-cdk 1.0.3, older than the version " +
            "this CLI vends (1.1.0). Fields this CLI writes that 1.0.3 does not know are " +
            "dropped at synth. Set it to 1.1.0, or run 'agentcore config " +
            "disableDependencyManagement false' to let the CLI manage it.",
        },
      ],
      installs: 0,
    });
    expect(await manifestOf(directory)).toBe(before);
  });

  test("warns about a specifier that is not a single pinned version", async () => {
    const directory = await cdkDirectoryWith({
      ...VENDED,
      dependencies: { ...VENDED.dependencies, "@aws/agentcore-cdk": "file:../cdk.tgz" },
    });

    expect((await run(directory)).events).toEqual([
      {
        type: "warning",
        message:
          "@aws/agentcore-cdk file:../cdk.tgz in agentcore/cdk/package.json is not a single " +
          "pinned version, so the CLI leaves it unchanged.",
      },
    ]);
  });

  test("keeps the indent, line endings, key order and unknown fields of package.json", async () => {
    const manifest = {
      name: "my-app",
      private: true,
      devDependencies: VENDED.devDependencies,
      dependencies: { ...VENDED.dependencies, "@aws/agentcore-cdk": "1.0.3" },
      overrides: { foo: "1.0.0" },
    };
    const format = (value: object) =>
      `${JSON.stringify(value, undefined, "\t").replace(/\n/g, "\r\n")}\r\n`;
    const directory = await cdkDirectoryWith(format(manifest));

    await run(directory);

    expect(await manifestOf(directory)).toBe(
      format({ ...manifest, dependencies: VENDED.dependencies }),
    );
  });

  test("reports a malformed package.json as a project state error", async () => {
    const directory = await cdkDirectoryWith({ dependencies: { "aws-cdk-lib": 5 } });

    await expect(run(directory)).rejects.toBeInstanceOf(ProjectStateError);
  });
});
