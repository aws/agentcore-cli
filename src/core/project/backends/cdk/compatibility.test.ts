import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  cdkCompatibilityWarning,
  MINIMUM_COMPATIBLE_CDK_VERSION,
  requireRuntimeCapabilities,
} from "./compatibility";
import { ProjectRuntimeSchema } from "../../../../projectSchemas/runtime";

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
  test("fails closed when a companion schema strips binding or role restrictions", async () => {
    const directory = await cdkDirectoryWith("999.0.0");
    const index = join(directory, "node_modules", "@aws", "agentcore-cdk", "index.js");
    await writeFile(
      index,
      "exports.AgentEnvSpecSchema = { safeParse: value => ({ success: true, data: {} }) };",
    );
    const runtime = ProjectRuntimeSchema.parse({
      name: "Export",
      build: "CodeZip",
      entrypoint: "main.py",
      codeLocation: "app/Export",
      runtimeVersion: "PYTHON_3_14",
      bindingMode: "explicit",
      executionRoleConfig: { policyMode: "explicit", tags: { team: "source" } },
      connections: [{ to: { type: "memory", name: "Selected" } }],
    });
    expect(() => requireRuntimeCapabilities(directory, [runtime])).toThrow(
      "access restrictions must not be silently stripped",
    );
    expect(() => requireRuntimeCapabilities(directory, [])).not.toThrow();
  });
  test("accepts a companion that retains the requested settings", async () => {
    const directory = await cdkDirectoryWith("999.0.0");
    await writeFile(
      join(directory, "node_modules", "@aws", "agentcore-cdk", "index.js"),
      "exports.AgentEnvSpecSchema = { safeParse: value => ({ success: true, data: value }) };",
    );
    const runtime = ProjectRuntimeSchema.parse({
      name: "Export",
      build: "CodeZip",
      entrypoint: "main.py",
      codeLocation: "app/Export",
      runtimeVersion: "PYTHON_3_14",
      bindingMode: "explicit",
    });
    expect(() => requireRuntimeCapabilities(directory, [runtime])).not.toThrow();
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
