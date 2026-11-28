import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProcessFailedError, runProcess, type ProcessRunner } from "../../../../io";
import {
  assertCdkFeatureSupport,
  cdkAcceptsPassthroughGateway,
  cdkCompatibilityWarning,
  cdkFeaturesFor,
  CDK_FEATURE_RELEASES,
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

describe("cdkAcceptsPassthroughGateway", () => {
  /** A CDK app whose @aws/agentcore-cdk has the module text `index`. */
  async function cdkDirectoryWithIndex(index: string | undefined): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "agentcore-cdk-passthrough-gateway-"));
    tempDirectories.push(directory);
    if (index === undefined) return directory;
    const packageDirectory = join(directory, "node_modules", "@aws", "agentcore-cdk");
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(
      join(packageDirectory, "package.json"),
      JSON.stringify({ name: "@aws/agentcore-cdk", version: "1.1.0", main: "index.js" }),
    );
    await writeFile(join(packageDirectory, "index.js"), index);
    return directory;
  }
  /** A library that exports `AgentCoreGatewayTargetSchema` as `schema`, a JS text. */
  const exporting = (schema: string) => `exports.AgentCoreGatewayTargetSchema = ${schema};\n`;
  /** As each @aws/agentcore-cdk parses the passthrough of a target: with `gateway`, or `endpoint` only. */
  const WITH_GATEWAY = exporting(
    "{ safeParse: (target) => ({ success: typeof target.passthrough.gateway === 'string' }) }",
  );
  const ENDPOINT_ONLY = exporting(
    "{ safeParse: (target) => ({ success: typeof target.passthrough.endpoint === 'string' }) }",
  );
  const withNode = test.skipIf(!Bun.which("node"));

  withNode("accepts when the installed library accepts passthrough.gateway", async () => {
    expect(await cdkAcceptsPassthroughGateway(await cdkDirectoryWithIndex(WITH_GATEWAY))).toEqual({
      accepts: true,
    });
  });

  withNode.each([
    ["requires passthrough.endpoint", ENDPOINT_ONLY],
    ["has no AgentCoreGatewayTargetSchema", "exports.Other = 1;\n"],
  ])("refuses when the installed library %s", async (_, index) => {
    expect(await cdkAcceptsPassthroughGateway(await cdkDirectoryWithIndex(index))).toEqual({
      accepts: false,
      reason: "refuses",
    });
  });

  withNode("loads only dist/schema of the library, and not the constructs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentcore-cdk-passthrough-gateway-"));
    tempDirectories.push(directory);
    const packageDirectory = join(directory, "node_modules", "@aws", "agentcore-cdk");
    await mkdir(join(packageDirectory, "dist", "schema"), { recursive: true });
    await writeFile(
      join(packageDirectory, "package.json"),
      JSON.stringify({ name: "@aws/agentcore-cdk", version: "1.1.0", main: "./dist/index.js" }),
    );
    // The entry of the package loads the constructs, which a check does not need.
    await writeFile(
      join(packageDirectory, "dist", "index.js"),
      'throw new Error("the check loaded the constructs");\n',
    );
    await writeFile(join(packageDirectory, "dist", "schema", "index.js"), WITH_GATEWAY);

    expect(await cdkAcceptsPassthroughGateway(directory)).toEqual({ accepts: true });
  });

  withNode("says that the library is not installed", async () => {
    expect(await cdkAcceptsPassthroughGateway(await cdkDirectoryWithIndex(undefined))).toEqual({
      accepts: false,
      reason: "not-installed",
    });
  });

  withNode("says that the check failed, with the error of the library", async () => {
    const directory = await cdkDirectoryWithIndex('throw new Error("the library is broken");\n');
    expect(await cdkAcceptsPassthroughGateway(directory)).toEqual({
      accepts: false,
      reason: "failed",
      detail: "the library is broken",
    });
  });

  withNode("says that the check took too long", async () => {
    const directory = await cdkDirectoryWithIndex("while (true) {}\n");
    expect(await cdkAcceptsPassthroughGateway(directory, { timeoutMs: 500 })).toEqual({
      accepts: false,
      reason: "timed-out",
    });
  });

  test("says that build cannot run node", async () => {
    const directory = await cdkDirectoryWithIndex(WITH_GATEWAY);
    expect(
      await cdkAcceptsPassthroughGateway(directory, { node: "/nonexistent/agentcore-test/node" }),
    ).toEqual({ accepts: false, reason: "no-node" });
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

  test("names only the missing feature and its minimum CDK version, and asks a managed project to update the CLI", async () => {
    const directory = await cdkPackage(CONTAINER_LOCAL + STRIPS_CONTAINER_URI);
    const error = await assertCdkFeatureSupport(directory, [
      "ContainerLocal",
      "Runtime containerUri",
    ]).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );
    expect(error?.message).toBe(
      "This project uses Runtime containerUri, which its @aws/agentcore-cdk package does not " +
        `support; it needs @aws/agentcore-cdk ${CDK_FEATURE_RELEASES["Runtime containerUri"]} or newer. ` +
        "The CLI installs the @aws/agentcore-cdk version it ships with, so update the CLI " +
        "(agentcore update), then rebuild or redeploy.",
    );
    expect(error?.message).not.toContain("#");
    expect(error?.message).not.toContain("npm install");
  });

  test("asks a project that manages its own dependencies to install the minimum CDK version", async () => {
    const directory = await cdkPackage(CONTAINER_LOCAL + STRIPS_CONTAINER_URI);
    const error = await assertCdkFeatureSupport(directory, ["Runtime containerUri"], runProcess, {
      dependenciesManaged: false,
    }).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );
    expect(error?.message).toBe(
      "This project uses Runtime containerUri, which its @aws/agentcore-cdk package does not " +
        `support; it needs @aws/agentcore-cdk ${CDK_FEATURE_RELEASES["Runtime containerUri"]} or newer. ` +
        `Install @aws/agentcore-cdk ${CDK_FEATURE_RELEASES["Runtime containerUri"]} or newer in ` +
        `${directory} (npm install), then rebuild or redeploy.`,
    );
    expect(error?.message).not.toContain("agentcore update");
  });

  test("names the newest minimum version when several features are missing", async () => {
    const directory = await cdkDirectoryWith("1.0.0");
    await expect(
      assertCdkFeatureSupport(directory, ["ContainerLocal", "Runtime containerUri"]),
    ).rejects.toThrow(
      `they need @aws/agentcore-cdk ${CDK_FEATURE_RELEASES["Runtime containerUri"]} or newer`,
    );
  });

  test("records each feature's minimum @aws/agentcore-cdk release", () => {
    expect(CDK_FEATURE_RELEASES).toEqual({
      ContainerLocal: "1.2.0",
      "Runtime containerUri": "1.3.0",
    });
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

  test("reports a package whose own dependency is missing as a load error", async () => {
    const directory = await cdkPackage('require("constructs");');
    const error = await assertCdkFeatureSupport(directory, ["Runtime containerUri"]).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );
    expect(error?.message).toContain(`Cannot load @aws/agentcore-cdk from ${directory}:`);
    expect(error?.message).toContain("Cannot find module 'constructs'");
    expect(error?.message).not.toContain("This project uses");
  });

  test("ignores Node stderr output after the probe result", async () => {
    const directory = await cdkPackage(CONTAINER_URI);
    const preload = join(directory, "noise.cjs");
    await writeFile(
      preload,
      'process.emitWarning("corp shim"); process.on("exit", () => console.error("corp shim bye"));',
    );
    const runner: ProcessRunner = (command, options) =>
      runProcess(command, {
        ...options,
        env: { ...process.env, NODE_OPTIONS: `--require ${preload}` },
      });
    await expect(
      assertCdkFeatureSupport(directory, ["Runtime containerUri"], runner),
    ).resolves.toBeUndefined();
  });

  test("reports a missing node concisely, without the probe source", async () => {
    const error = await assertCdkFeatureSupport(
      "/project/cdk",
      ["Runtime containerUri"],
      (command) =>
        Promise.reject(
          new ProcessFailedError(command, "/project/cdk", null, "Error: spawn node ENOENT"),
        ),
    ).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );
    expect(error?.message).toBe(
      "Node.js was not found on your PATH; it is required to check the @aws/agentcore-cdk " +
        "package installed in /project/cdk. Install Node.js, then rebuild or redeploy.",
    );
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
        options.onOutput?.('noise\nagentcore-cdk-probe-result:{"missing":[]}\nmore noise');
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
