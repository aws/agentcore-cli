import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertContainerBuildRoleSupport,
  cdkCompatibilityWarning,
  MINIMUM_COMPATIBLE_CDK_VERSION,
} from "./compatibility";
import { ProjectSpecSchema } from "../../../../projectSchemas/project";

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
  test("skips the build-role capability check for existing projects", () => {
    const spec = ProjectSpecSchema.parse({ name: "example", version: 2 });
    expect(() => assertContainerBuildRoleSupport("/missing/cdk", spec)).not.toThrow();
  });

  test.each([false, true])("checks installed CDK build-role support: %s", async (supported) => {
    const directory = await cdkDirectoryWith("1.0.0-rc.4");
    await writeFile(
      join(directory, "node_modules", "@aws", "agentcore-cdk", "index.js"),
      `exports.AgentEnvSpecSchema = { shape: ${JSON.stringify(
        supported
          ? {
              containerBuildRoleArn: {},
              containerBuildHandlerRoleArn: {},
            }
          : {},
      )} };`,
    );
    const spec = ProjectSpecSchema.parse({
      name: "example",
      version: 2,
      runtimes: [
        {
          name: "example",
          build: "Container",
          codeLocation: "app",
          entrypoint: "main.py",
          containerBuildRoleArn: "arn:aws:iam::111122223333:role/Build",
          containerBuildHandlerRoleArn: "arn:aws:iam::111122223333:role/Handler",
        },
      ],
    });
    if (supported) {
      expect(() => assertContainerBuildRoleSupport(directory, spec)).not.toThrow();
    } else {
      expect(() => assertContainerBuildRoleSupport(directory, spec)).toThrow("does not support");
    }
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
