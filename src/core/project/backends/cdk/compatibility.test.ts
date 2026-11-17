import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertCdkFeatureSupport,
  cdkCompatibilityWarning,
  cdkFeaturesFor,
  MINIMUM_COMPATIBLE_CDK_VERSION,
} from "./compatibility";

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

// These run the real Node probe against fake @aws/agentcore-cdk packages.
describe("assertCdkFeatureSupport", () => {
  const CONTAINER_LOCAL =
    'exports.BuildTypeSchema = { safeParse: value => ({ success: value === "ContainerLocal" }) };' +
    "exports.LocalContainerImageAsset = class {};";
  const CONTAINER_URI =
    "exports.AgentEnvSpecSchema = { safeParse: input => ({ success: true, data: input }) };";
  const STRIPS_CONTAINER_URI =
    "exports.AgentEnvSpecSchema = { safeParse: () => ({ success: true, data: {} }) };";

  async function cdkPackage(code: string): Promise<string> {
    const directory = await cdkDirectoryWith("1.0.2-rc.1");
    const packageDirectory = join(directory, "node_modules", "@aws", "agentcore-cdk");
    await writeFile(
      join(packageDirectory, "package.json"),
      JSON.stringify({ version: "1.0.2-rc.1", main: "index.cjs" }),
    );
    await writeFile(join(packageDirectory, "index.cjs"), code);
    return directory;
  }

  test("accepts a package that supports every feature the project uses", async () => {
    const directory = await cdkPackage(CONTAINER_LOCAL + CONTAINER_URI);
    await expect(
      assertCdkFeatureSupport(directory, ["ContainerLocal", "Runtime containerUri"]),
    ).resolves.toBeUndefined();
  });

  test("names only the missing feature and its CDK release", async () => {
    const directory = await cdkPackage(CONTAINER_LOCAL + STRIPS_CONTAINER_URI);
    const error = await assertCdkFeatureSupport(directory, [
      "ContainerLocal",
      "Runtime containerUri",
    ]).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );
    expect(error?.message).toContain("This project uses Runtime containerUri,");
    expect(error?.message).toContain("#440");
    expect(error?.message).not.toContain("#463");
  });

  test("reports every feature when the package cannot be loaded", async () => {
    const directory = await cdkDirectoryWith("1.0.0");
    await expect(
      assertCdkFeatureSupport(directory, ["ContainerLocal", "Runtime containerUri"]),
    ).rejects.toThrow("ContainerLocal and Runtime containerUri");
  });

  test("asks to update the dependency when the package is not installed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentcore-cdk-compatibility-"));
    tempDirectories.push(directory);
    await expect(assertCdkFeatureSupport(directory, ["ContainerLocal"])).rejects.toThrow(
      "This project uses ContainerLocal,",
    );
  });

  test("reports a package that fails to load with its own error", async () => {
    const directory = await cdkPackage('throw new Error("corrupt install");');
    const error = await assertCdkFeatureSupport(directory, ["ContainerLocal"]).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );
    expect(error?.message).toContain("Cannot load @aws/agentcore-cdk");
    expect(error?.message).toContain("corrupt install");
    expect(error?.message).not.toContain("This project uses");
  });

  test("runs no probe when the project uses neither feature", async () => {
    await expect(
      assertCdkFeatureSupport("/missing/project", [], async () => {
        throw new Error("must not probe");
      }),
    ).resolves.toBeUndefined();
  });

  test("passes only feature names to the Node probe", async () => {
    const commands: string[][] = [];
    await assertCdkFeatureSupport(
      "/project/cdk",
      ["Runtime containerUri"],
      async (command, options) => {
        expect(options.cwd).toBe("/project/cdk");
        commands.push(command);
        options.onOutput?.('{"missing":[]}');
      },
    );
    expect(commands[0]?.slice(0, 3)).toEqual(["node", "--input-type=commonjs", "-e"]);
    expect(commands[0]?.at(-1)).toBe('["Runtime containerUri"]');
  });
});

describe("cdkFeaturesFor", () => {
  test("derives features from the workload build modes", () => {
    expect(cdkFeaturesFor({ "runtime/a": "CodeZip", "harness/h": "ContainerUri" })).toEqual([]);
    expect(cdkFeaturesFor({ "runtime/a": "ContainerUri", "harness/h": "ContainerLocal" })).toEqual([
      "ContainerLocal",
      "Runtime containerUri",
    ]);
  });
});
