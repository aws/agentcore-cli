import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertPrebuiltRuntimeSupport,
  cdkCompatibilityWarning,
  MINIMUM_COMPATIBLE_CDK_VERSION,
} from "./compatibility";
import type { ProjectRuntime } from "../../../../projectSchemas/runtime";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function cdkDirectoryWith(version: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-cdk-compatibility-"));
  tempDirectories.push(directory);
  const packageDirectory = join(directory, "node_modules", "@aws", "agentcore-cdk");
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(join(packageDirectory, "package.json"), JSON.stringify({ version }));
  return directory;
}

describe("cdkCompatibilityWarning", () => {
  test.each(["0.0.0-0", "1.0.0-rc.1", "1.0.0-rc.2"])(
    "warns for incompatible version %s",
    async (version) => {
      const directory = await cdkDirectoryWith(version);

      const warning = await cdkCompatibilityWarning(directory);

      expect(warning).toContain(`@aws/agentcore-cdk ${version}`);
      expect(warning).toContain(`${MINIMUM_COMPATIBLE_CDK_VERSION} or newer`);
      expect(warning).toContain("Update the CDK dependency, then rebuild or redeploy");
    },
  );

  test.each([MINIMUM_COMPATIBLE_CDK_VERSION, "999.0.0"])(
    "does not warn for compatible version %s",
    async (version) => {
      const directory = await cdkDirectoryWith(version);
      expect(await cdkCompatibilityWarning(directory)).toBeUndefined();
    },
  );

  test.each([undefined, "not-semver"])(
    "does not replace dependency errors for an unreadable version %s",
    async (version) => {
      const directory = await cdkDirectoryWith(version);
      expect(await cdkCompatibilityWarning(directory)).toBeUndefined();
    },
  );

  test("does not replace dependency errors when the package is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentcore-cdk-compatibility-"));
    tempDirectories.push(directory);
    expect(await cdkCompatibilityWarning(directory)).toBeUndefined();
  });
});

describe("pre-built Runtime CDK support", () => {
  const runtime: ProjectRuntime = {
    name: "image",
    build: "Container",
    codeLocation: "app/image" as ProjectRuntime["codeLocation"],
    entrypoint: "main.py",
    containerUri: "123456789012.dkr.ecr.us-west-2.amazonaws.com/agent:v1",
  };

  async function schemaPackage(code: string): Promise<string> {
    const directory = await cdkDirectoryWith("1.0.1");
    const packageDirectory = join(directory, "node_modules", "@aws", "agentcore-cdk");
    await writeFile(
      join(packageDirectory, "package.json"),
      JSON.stringify({ version: "1.0.1", main: "index.cjs" }),
    );
    await writeFile(join(packageDirectory, "index.cjs"), code);
    return directory;
  }

  test("fails when the installed schema strips containerUri", async () => {
    const directory = await schemaPackage(
      "exports.AgentEnvSpecSchema = { safeParse: () => ({ success: true, data: {} }) };",
    );
    await expect(assertPrebuiltRuntimeSupport(directory, [runtime])).rejects.toThrow(
      "does not support pre-built Runtime images",
    );
  });

  test("accepts a schema that preserves the configured URI", async () => {
    const directory = await schemaPackage(
      "exports.AgentEnvSpecSchema = { safeParse: input => ({ success: true, data: input }) };",
    );
    await expect(assertPrebuiltRuntimeSupport(directory, [runtime])).resolves.toBeUndefined();
  });

  test("fails for missing or broken feature dependencies", async () => {
    const directory = await cdkDirectoryWith("1.0.0");
    await expect(assertPrebuiltRuntimeSupport(directory, [runtime])).rejects.toThrow("#440");
  });

  test("does not load the CDK package for ordinary runtimes", async () => {
    await expect(
      assertPrebuiltRuntimeSupport(
        "/missing/project",
        [{ ...runtime, containerUri: undefined }],
        async () => {
          throw new Error("ordinary runtimes must not launch the feature probe");
        },
      ),
    ).resolves.toBeUndefined();
  });

  test("probes with Node without passing environment secrets to the process", async () => {
    const commands: string[][] = [];
    await assertPrebuiltRuntimeSupport(
      "/project/cdk",
      [{ ...runtime, envVars: [{ name: "TOKEN", value: "sensitive-test-value" }] }],
      async (command, options) => {
        expect(options.cwd).toBe("/project/cdk");
        commands.push(command);
      },
    );
    expect(commands[0]?.slice(0, 3)).toEqual(["node", "--input-type=commonjs", "-e"]);
    expect(commands[0]?.at(-1)).toBe(runtime.containerUri);
    expect(JSON.stringify(commands)).not.toContain("sensitive-test-value");
  });
});
