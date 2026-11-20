import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { partition } from "@aws-sdk/util-endpoints";

/**
 * True when the region belongs to the aws-cn partition (cn-north-1,
 * cn-northwest-1), per the AWS SDK's partition data rather than a name
 * prefix. Features whose backing services are not reachable from that
 * partition (template model providers, Bedrock Agent import, the telemetry
 * collector) gate on this.
 */
export function isChinaRegion(region: string): boolean {
  return partition(region).name === "aws-cn";
}

/**
 * Regions where AgentCore Runtime offers no platformVersion V2. Box runs only on V2. The list is
 * the AgentCore Runtime team's; remove a region here once V2 launches in it.
 */
const NO_RUNTIME_V2_REGIONS: ReadonlySet<string> = new Set(["ap-south-2", "us-west-1"]);
/**
 * Partitions with no V2 in any region: GovCloud, and the isolated (ADC) partitions. The European
 * Sovereign Cloud (`aws-eusc`) is left out on purpose: like a region the CLI does not list, it
 * counts as having V2, and CreateAgentRuntime refuses it there if it does not.
 */
const NO_RUNTIME_V2_PARTITIONS: ReadonlySet<string> = new Set([
  "aws-us-gov",
  "aws-iso",
  "aws-iso-b",
  "aws-iso-e",
  "aws-iso-f",
]);

/**
 * Whether AgentCore Runtime offers platformVersion V2 in `region`. A region not listed counts as
 * having V2, so a new region needs no CLI release; one without V2 fails at CreateAgentRuntime.
 */
export function supportsRuntimeV2(region: string): boolean {
  return (
    !NO_RUNTIME_V2_REGIONS.has(region) && !NO_RUNTIME_V2_PARTITIONS.has(partition(region).name)
  );
}

/**
 * True when the CLI is operating in a China (aws-cn) context: the caller's
 * resolved region (when provided — telemetry resolves through the same chain
 * as withRegion) or the ambient AWS region env vars point at a China region,
 * or the AgentCore project enclosing `cwd` declares a China-region deployment
 * target in
 * agentcore/aws-targets.json.
 *
 * Best-effort by design — a missing project or an unreadable/malformed targets
 * file counts as non-China — so callers that must never fail (telemetry) can
 * rely on it unconditionally.
 */
export async function isChinaContext(
  options: { region?: string; cwd?: string } = {},
): Promise<boolean> {
  const cwd = options.cwd ?? process.cwd();
  if (options.region !== undefined && isChinaRegion(options.region)) return true;
  if (isChinaRegion(process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "")) return true;

  // Mirror project discovery: walk up to the first directory containing
  // agentcore/agentcore.json, then inspect its aws-targets.json.
  let dir = cwd;
  while (!existsSync(join(dir, "agentcore", "agentcore.json"))) {
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
  try {
    const raw = await readFile(join(dir, "agentcore", "aws-targets.json"), "utf8");
    const targets: unknown = JSON.parse(raw);
    return (
      Array.isArray(targets) &&
      targets.some(
        (target) =>
          typeof target === "object" &&
          target !== null &&
          "region" in target &&
          typeof target.region === "string" &&
          isChinaRegion(target.region),
      )
    );
  } catch {
    return false;
  }
}
