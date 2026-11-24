import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertCdkLocalContainerSupport,
  cdkAcceptsPassthroughGateway,
  cdkCompatibilityWarning,
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
  test("rejects an older package that would ignore a local harness build selection", async () => {
    const directory = await cdkDirectoryWith("1.0.1");
    const packageDirectory = join(directory, "node_modules", "@aws", "agentcore-cdk");
    await writeFile(
      join(packageDirectory, "index.js"),
      "exports.BuildTypeSchema = { safeParse: () => ({ success: false }) };",
    );
    expect(() => assertCdkLocalContainerSupport(directory)).toThrow('supports "ContainerLocal"');
  });

  test("asks to update the dependency when the package is not installed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentcore-cdk-compatibility-"));
    tempDirectories.push(directory);
    expect(() => assertCdkLocalContainerSupport(directory)).toThrow('supports "ContainerLocal"');
  });

  test("reports a package that fails to load with its own error", async () => {
    const directory = await cdkDirectoryWith("1.0.2");
    const packageDirectory = join(directory, "node_modules", "@aws", "agentcore-cdk");
    await writeFile(join(packageDirectory, "index.js"), 'throw new Error("corrupt install");');
    let message = "";
    try {
      assertCdkLocalContainerSupport(directory);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("Cannot load @aws/agentcore-cdk");
    expect(message).toContain("corrupt install");
    expect(message).not.toContain('supports "ContainerLocal"');
  });

  test("accepts a supporting local or prerelease CDK package by capability", async () => {
    const directory = await cdkDirectoryWith("1.0.2-rc.1");
    const packageDirectory = join(directory, "node_modules", "@aws", "agentcore-cdk");
    await writeFile(
      join(packageDirectory, "index.js"),
      'exports.BuildTypeSchema = { safeParse: value => ({ success: value === "ContainerLocal" }) }; exports.LocalContainerImageAsset = class {};',
    );
    expect(() => assertCdkLocalContainerSupport(directory)).not.toThrow();
  });
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
