import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
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
  /** A CDK app whose @aws/agentcore-cdk exports `PassthroughConfigSchema` as `schema`, a JS text. */
  async function cdkDirectoryExporting(schema: string | undefined): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "agentcore-cdk-passthrough-gateway-"));
    tempDirectories.push(directory);
    if (schema === undefined) return directory;
    const packageDirectory = join(directory, "node_modules", "@aws", "agentcore-cdk");
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(
      join(packageDirectory, "package.json"),
      JSON.stringify({ name: "@aws/agentcore-cdk", version: "1.1.0", main: "index.js" }),
    );
    await writeFile(
      join(packageDirectory, "index.js"),
      `exports.PassthroughConfigSchema = ${schema};\n`,
    );
    return directory;
  }
  /** As each @aws/agentcore-cdk parses a passthrough: with `gateway`, or with `endpoint` only. */
  const WITH_GATEWAY =
    "{ safeParse: (config) => ({ success: typeof config.gateway === 'string' }) }";
  const ENDPOINT_ONLY =
    "{ safeParse: (config) => ({ success: typeof config.endpoint === 'string' }) }";

  test.skipIf(!Bun.which("node"))(
    "is true when the installed library accepts passthrough.gateway",
    async () => {
      expect(await cdkAcceptsPassthroughGateway(await cdkDirectoryExporting(WITH_GATEWAY))).toBe(
        true,
      );
    },
  );

  test.skipIf(!Bun.which("node"))(
    "is false when the installed library requires passthrough.endpoint",
    async () => {
      expect(await cdkAcceptsPassthroughGateway(await cdkDirectoryExporting(ENDPOINT_ONLY))).toBe(
        false,
      );
    },
  );

  test.skipIf(!Bun.which("node"))(
    "is false when the library is not installed, or has no PassthroughConfigSchema",
    async () => {
      expect(await cdkAcceptsPassthroughGateway(await cdkDirectoryExporting(undefined))).toBe(
        false,
      );
      expect(await cdkAcceptsPassthroughGateway(await cdkDirectoryExporting("undefined"))).toBe(
        false,
      );
    },
  );
});
