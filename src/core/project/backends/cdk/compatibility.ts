import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
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
  } catch (error) {
    // A missing package falls through to "update the dependency". Anything else is a
    // broken install, which that advice would hide.
    const code = (error as { code?: unknown }).code;
    if (code !== "MODULE_NOT_FOUND" && code !== "ERR_MODULE_NOT_FOUND") {
      throw new ProjectStateError(
        `Cannot load @aws/agentcore-cdk from ${cdkDirectory}: ` +
          (error instanceof Error ? error.message : String(error)),
        { cause: error },
      );
    }
  }
  // An old or unavailable package must never silently strip a harness build selection.
  throw new ProjectStateError(
    'This project requires an @aws/agentcore-cdk package that supports "ContainerLocal". ' +
      `Update the dependency in ${cdkDirectory} and run npm install.`,
  );
}

/** The `@aws/agentcore-cdk` version installed in `node_modules`, if it can be read. */
export async function installedCdkVersion(cdkDirectory: string): Promise<string | undefined> {
  const packagePath = join(cdkDirectory, "node_modules", "@aws", "agentcore-cdk", "package.json");
  try {
    const { version } = JSON.parse(await readFile(packagePath, "utf8")) as { version?: unknown };
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

export async function cdkCompatibilityWarning(cdkDirectory: string): Promise<string | undefined> {
  const installedVersion = await installedCdkVersion(cdkDirectory);
  if (
    installedVersion === undefined ||
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

/**
 * Asks the @aws/agentcore-cdk that the CDK app in `cdkDirectory` loads whether its schema takes a
 * passthrough target with `gateway` in place of `endpoint`. Node runs the check in that folder, so
 * it loads the same library as synth. False when the library is missing or the check fails.
 */
const PASSTHROUGH_GATEWAY_CHECK = `
let accepts = false;
try {
  const { PassthroughConfigSchema } = require("@aws/agentcore-cdk");
  accepts = PassthroughConfigSchema.safeParse({ gateway: "check", protocolType: "CUSTOM" }).success === true;
} catch {}
process.stdout.write(accepts ? "accepts" : "refuses");
`;

export async function cdkAcceptsPassthroughGateway(cdkDirectory: string): Promise<boolean> {
  try {
    const { stdout } = await promisify(execFile)("node", ["-e", PASSTHROUGH_GATEWAY_CHECK], {
      cwd: cdkDirectory,
      timeout: 60_000,
    });
    return stdout.trim() === "accepts";
  } catch {
    return false;
  }
}
