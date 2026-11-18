import { readFile } from "node:fs/promises";
import { join } from "node:path";
import semver from "semver";
import { createRequire } from "node:module";
import { ProjectStateError } from "../../../../errors";

export const MINIMUM_COMPATIBLE_CDK_VERSION = "1.0.0";

/** Detect support directly so prereleases and local CDK packages also work. */
export function assertCdkLocalContainerSupport(cdkDirectory: string): void {
  try {
    const require = createRequire(join(cdkDirectory, "package.json"));
    const cdk = require("@aws/agentcore-cdk") as {
      BuildTypeSchema?: { safeParse(value: string): { success: boolean } };
      LocalContainerImageAsset?: unknown;
    };
    if (cdk.BuildTypeSchema?.safeParse("ContainerLocal").success && cdk.LocalContainerImageAsset)
      return;
  } catch {
    // An old or unavailable package must never silently strip a harness build selection.
  }
  throw new ProjectStateError(
    'This project requires an @aws/agentcore-cdk package that supports "ContainerLocal". ' +
      `Update the dependency in ${cdkDirectory} and run npm install.`,
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
