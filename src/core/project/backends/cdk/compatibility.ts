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
 * The script that asks the @aws/agentcore-cdk that the CDK app loads whether its schema takes a
 * passthrough target with `gateway` in place of `endpoint`, as build writes it. It parses a whole
 * target, because the library gives `gateway` a passthrough schema of its own. It prints
 * `accepts`, `refuses`, `not-installed`, or `failed` and the error.
 */
const PASSTHROUGH_GATEWAY_CHECK = `
let library;
try {
  library = require("@aws/agentcore-cdk");
} catch (error) {
  const missing = error && error.code === "MODULE_NOT_FOUND" && /@aws\\/agentcore-cdk/.test(String(error.message));
  process.stdout.write(missing ? "not-installed" : "failed " + (error && error.message));
  process.exit(0);
}
const schema = library.AgentCoreGatewayTargetSchema;
const accepts =
  schema !== undefined &&
  schema.safeParse({
    name: "egress-gateway-check",
    targetType: "passthrough",
    passthrough: { gateway: "check", protocolType: "CUSTOM" },
    outboundAuth: { type: "GATEWAY_IAM_ROLE", service: "bedrock-agentcore", region: "us-east-1" },
  }).success === true;
process.stdout.write(accepts ? "accepts" : "refuses");
`;

/** The answer of {@link cdkAcceptsPassthroughGateway}, with the reason when it is not `accepts`. */
export type PassthroughGatewayCheck =
  | { readonly accepts: true }
  | {
      readonly accepts: false;
      readonly reason: "refuses" | "not-installed" | "no-node" | "timed-out" | "failed";
      readonly detail?: string;
    };

/**
 * Asks the @aws/agentcore-cdk of the CDK app in `cdkDirectory` whether it accepts
 * `passthrough.gateway`. Node runs the check in that folder, so it loads the same library as synth.
 * Each answer other than `accepts` says why: the library refuses the field, is not installed, the
 * check took more than `timeoutMs`, `node` is not there, or the check failed.
 */
export async function cdkAcceptsPassthroughGateway(
  cdkDirectory: string,
  options: { readonly node?: string; readonly timeoutMs?: number } = {},
): Promise<PassthroughGatewayCheck> {
  let stdout: string;
  try {
    ({ stdout } = await promisify(execFile)(
      options.node ?? "node",
      ["-e", PASSTHROUGH_GATEWAY_CHECK],
      { cwd: cdkDirectory, timeout: options.timeoutMs ?? 60_000 },
    ));
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { killed?: boolean; stderr?: string };
    if (failure.code === "ENOENT") return { accepts: false, reason: "no-node" };
    if (failure.killed) return { accepts: false, reason: "timed-out" };
    const detail = (failure.stderr ?? failure.message).trim().split("\n")[0];
    return { accepts: false, reason: "failed", ...(detail && { detail }) };
  }
  const answer = stdout.trim();
  if (answer === "accepts") return { accepts: true };
  if (answer === "refuses" || answer === "not-installed") return { accepts: false, reason: answer };
  const detail = answer.replace(/^failed\s*/, "");
  return { accepts: false, reason: "failed", ...(detail && { detail }) };
}
