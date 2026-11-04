import { readFile } from "node:fs/promises";
import { join } from "node:path";
import semver from "semver";
import type { ProjectRuntime } from "../../../../projectSchemas/runtime";
import { ProjectStateError } from "../../../../errors";
import { runProcess, type ProcessRunner } from "../../../../io";

export const MINIMUM_COMPATIBLE_CDK_VERSION = "1.0.0";

const PREBUILT_SCHEMA_PROBE = `
const { createRequire } = require("node:module");
const { join } = require("node:path");
const library = createRequire(join(process.cwd(), "package.json"))("@aws/agentcore-cdk");
const containerUri = process.argv[1];
const parsed = library.AgentEnvSpecSchema?.safeParse({
  name: "prebuilt_compatibility",
  build: "Container",
  entrypoint: "main.py",
  codeLocation: "app/prebuilt_compatibility",
  containerUri,
});
if (!parsed?.success || parsed.data.containerUri !== containerUri) process.exitCode = 1;
`;

/**
 * Older Runtime schemas strip containerUri; do not let them select CodeBuild silently.
 * Probe in Node, like the CDK app: standalone binaries cannot reliably resolve the
 * project's external modules through their compiled-in Bun module resolver.
 */
export async function assertPrebuiltRuntimeSupport(
  cdkDirectory: string,
  runtimes: readonly ProjectRuntime[],
  runner: ProcessRunner = runProcess,
): Promise<void> {
  const prebuilt = runtimes.find((runtime) => runtime.containerUri !== undefined);
  if (!prebuilt) return;
  let cause: unknown;
  try {
    // Only the image URI is passed, never the Runtime's environment or credentials.
    await runner(
      ["node", "--input-type=commonjs", "-e", PREBUILT_SCHEMA_PROBE, prebuilt.containerUri!],
      {
        cwd: cdkDirectory,
      },
    );
    return;
  } catch (error) {
    // Report the feature dependency instead of an incidental module-load error.
    cause = error;
  }
  throw new ProjectStateError(
    `Runtime "${prebuilt.name}" uses containerUri, but this project's @aws/agentcore-cdk ` +
      `does not support pre-built Runtime images. Install a release containing ` +
      `aws/agentcore-l3-cdk-constructs#440 in ${cdkDirectory}, then rebuild or redeploy.`,
    { cause },
  );
}

export async function cdkCompatibilityWarning(cdkDirectory: string): Promise<string | undefined> {
  const packagePath = join(cdkDirectory, "node_modules", "@aws", "agentcore-cdk", "package.json");

  let installedVersion: unknown;
  try {
    const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as {
      version?: unknown;
    };
    installedVersion = packageJson.version;
  } catch {
    return undefined;
  }

  if (
    typeof installedVersion !== "string" ||
    semver.valid(installedVersion) === null ||
    !semver.lt(installedVersion, MINIMUM_COMPATIBLE_CDK_VERSION)
  ) {
    return undefined;
  }

  return (
    `This project uses @aws/agentcore-cdk ${installedVersion}, but this CLI requires ` +
    `${MINIMUM_COMPATIBLE_CDK_VERSION} or newer for full compatibility. ` +
    `Update the CDK dependency, then rebuild or redeploy.`
  );
}
