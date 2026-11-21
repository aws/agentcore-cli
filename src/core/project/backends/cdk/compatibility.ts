import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import semver from "semver";

export const MINIMUM_COMPATIBLE_CDK_VERSION = "1.0.0";

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
