import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ProcessRunner } from "../../../io";
import { CDK_LIBRARY_OVERRIDE_ENV, createWorkspaceSynthesizer, librarySpec } from "./synth";

const cleanups: Array<() => Promise<void>> = [];
afterEach(() => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentcore-synth-test-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "agentcore", "cdk"), { recursive: true });
  await writeFile(
    join(root, "agentcore", "cdk", "package.json"),
    JSON.stringify({ dependencies: { "@aws/agentcore-cdk": "1.0.0-rc.3", constructs: "~10.7.0" } }),
  );
  return root;
}

function recordingRunner(): {
  runner: ProcessRunner;
  commands: { command: string[]; cwd: string }[];
} {
  const commands: { command: string[]; cwd: string }[] = [];
  return {
    commands,
    runner: async (command, { cwd }) => {
      commands.push({ command, cwd });
    },
  };
}

const manifest = async (root: string) =>
  JSON.parse(await readFile(join(root, "agentcore", "cdk", "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };

describe("createWorkspaceSynthesizer", () => {
  test("installs and synthesizes in the workspace's CDK app, with deploy's synth command", async () => {
    const root = await workspace();
    const { runner, commands } = recordingRunner();
    const steps: string[] = [];

    const assembly = await createWorkspaceSynthesizer({ runner, env: {} })(root, {
      onStep: (step) => steps.push(step),
    });

    const cdk = join(root, "agentcore", "cdk");
    expect(assembly).toBe(join(cdk, "cdk.out"));
    expect(commands).toEqual([
      { command: ["npm", "install", "--no-audit", "--no-fund"], cwd: cdk },
      {
        command: ["npm", "run", "cdk", "--", "synth", "--quiet", "--output", join(cdk, "cdk.out")],
        cwd: cdk,
      },
    ]);
    expect(steps).toHaveLength(2);
    expect((await manifest(root)).dependencies["@aws/agentcore-cdk"]).toBe("1.0.0-rc.3");
  });

  test(`${CDK_LIBRARY_OVERRIDE_ENV} replaces the library dependency before installing`, async () => {
    const root = await workspace();
    const { runner } = recordingRunner();
    await createWorkspaceSynthesizer({
      runner,
      env: { [CDK_LIBRARY_OVERRIDE_ENV]: "./lib.tgz" },
      cwd: "/work",
    })(root);
    expect((await manifest(root)).dependencies).toEqual({
      "@aws/agentcore-cdk": `file:${resolve("/work", "lib.tgz")}`,
      constructs: "~10.7.0",
    });
  });

  test("propagates a failed install or synth", async () => {
    const root = await workspace();
    const runner: ProcessRunner = async (command) => {
      if (command[1] === "run") throw new Error("synth failed");
    };
    await expect(createWorkspaceSynthesizer({ runner, env: {} })(root)).rejects.toThrow(
      "synth failed",
    );
  });
});

describe("librarySpec", () => {
  test("turns paths into absolute file: specs and passes npm specs through", () => {
    // Resolved the platform's way, so these hold on Windows too.
    const file = (...segments: string[]) => `file:${resolve(...segments)}`;
    expect(librarySpec("./x.tgz", "/w")).toBe(file("/w", "x.tgz"));
    expect(librarySpec("../lib", "/w/a")).toBe(file("/w", "lib"));
    expect(librarySpec("/abs/lib.tgz", "/w")).toBe(file("/abs/lib.tgz"));
    expect(librarySpec("aws-agentcore-cdk-1.0.0.tgz", "/w")).toBe(
      file("/w", "aws-agentcore-cdk-1.0.0.tgz"),
    );
    expect(librarySpec("file:../lib", "/w")).toBe("file:../lib");
    expect(librarySpec("1.0.0-rc.4", "/w")).toBe("1.0.0-rc.4");
    expect(librarySpec("@aws/agentcore-cdk@next", "/w")).toBe("@aws/agentcore-cdk@next");
  });
});
