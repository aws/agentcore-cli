import {
  stackBlockerCount,
  type PinnedName,
  type PinnedResourceType,
  type StackMigrationPlan,
  type StackResourceChange,
} from "../../../handlers/project/migrate/types";
import type { AwsDeploymentTarget } from "../../../projectSchemas/aws-targets";
import { buildBridgeTemplate, verifyBridge } from "./bridge";
import { mapLogicalIds, NAME_PROPERTIES, renamesOf, type LogicalIdMapping } from "./mapping";
import { deployImpact } from "./replacements";
import { resourcesToRetain, withRetain } from "./retain";
import { CDK_METADATA_TYPE, resourcesOf, type CfnTemplate } from "./templates";
import { resourcesOutsideV0App } from "./v0CdkApp";

/**
 * Planning is where a migration proves it's safe before it touches anything: it
 * works out the stack refactor and predicts the first v1 deploy, so a plan that
 * would replace or delete a resource the user needs is refused up front instead
 * of discovered in AWS.
 */
export type StackPlanInput = {
  target: AwsDeploymentTarget;
  /** The deployed stack's name. */
  stackName: string;
  /** The template the stack was last deployed with. */
  deployed: CfnTemplate;
  /** The v1 app's template for the same target. */
  v1: CfnTemplate;
  /** The stack name the v1 app synthesized for the target. */
  v1StackName: string;
  /** The deployed names this target's resources keep, which the v1 synth must render. */
  pins: PinnedName[];
};

/** A stack's plan, with what applying it needs. */
export type PlannedStack = {
  plan: StackMigrationPlan;
  mapping: LogicalIdMapping;
  /** Logical ID renames the refactor applies. */
  renames: Map<string, string>;
  /** The template the refactor moves the stack to; absent when it couldn't be built. */
  bridge?: CfnTemplate;
  /**
   * The update to make before the refactor: the deployed template with retain
   * policies on the unsupported resources it keeps. Absent when nothing needs it.
   */
  retain?: { template: CfnTemplate; logicalIds: Set<string> };
};

/**
 * Plans how one stack moves from its deployed v0 template to the v1 template:
 * which resources a stack refactor moves to new logical IDs, the bridge template
 * the refactor applies (verified to change nothing but logical IDs), and what
 * the first v1 deploy after it creates, deletes, and replaces. Reads nothing
 * from AWS; the templates are passed in.
 */
export async function planStack(input: StackPlanInput): Promise<PlannedStack> {
  const { target, stackName, deployed, v1 } = input;
  const mapping = mapLogicalIds(deployed, v1);
  const renames = renamesOf(mapping);
  const plan: StackMigrationPlan = {
    target: target.name,
    account: target.account,
    region: target.region,
    stackName,
    moves: mapping.matches
      .filter((match) => renames.has(match.from))
      .map(({ type, from, to }) => ({ type, from, to })),
    unchanged: mapping.matches.filter(
      (match) => match.from === match.to && match.type !== CDK_METADATA_TYPE,
    ).length,
    added: [],
    removed: [],
    replaced: [],
    updated: [],
    blockers: [],
    ready: false,
  };

  if (input.v1StackName !== stackName) {
    plan.blockers.push(
      `The v1 app names this target's stack '${input.v1StackName}', not '${stackName}', so a v1 ` +
        "deploy would create a new stack instead of updating this one.",
    );
  }

  const nested = Object.entries(resourcesOf(deployed))
    .filter(([, resource]) => resource.Type === NESTED_STACK_TYPE)
    .map(([id]) => id);
  if (nested.length > 0) {
    plan.blockers.push(
      `The stack has nested stacks (${nested.join(", ")}), which the v0 CDK app doesn't create ` +
        "and migrate can't plan.",
    );
  }
  const outside = resourcesOutsideV0App(deployed);
  if (outside.length > 0) {
    plan.blockers.push(
      `The deployed stack has resources the v0 CDK app doesn't create: ${outside.join("; ")}. ` +
        "Migrating replaces agentcore/cdk with v1's app, so the first v1 deploy would delete " +
        "them. Move them out of the stack (or remove them) with the v0 CLI before migrating.",
    );
  }
  const chained = chainedRenames(renames);
  if (chained.length > 0) {
    plan.blockers.push(
      `The refactor would rename into logical IDs it also renames away from (${chained.join(", ")}). ` +
        "Chained and swapped renames haven't been verified with CloudFormation stack refactoring, " +
        "so migrate doesn't attempt them.",
    );
  }

  // Resources migrate deliberately leaves out of v1 are kept: the stack is first
  // updated to retain them and their dropped dependencies, so the refactor and
  // the deploy start from there.
  const retained = resourcesToRetain(
    deployed,
    new Set(mapping.onlyInOld.map((resource) => resource.logicalId)),
  );
  let start = deployed;
  let retain: PlannedStack["retain"];
  if (retained.length > 0) {
    plan.retained = retained.map(({ logicalId, type }) => ({ logicalId, type }));
    start = withRetain(
      deployed,
      retained.map((resource) => resource.logicalId),
    );
    const needed = retained.filter((resource) => !resource.alreadyRetained);
    if (needed.length > 0) {
      retain = {
        template: start,
        logicalIds: new Set(needed.map((resource) => resource.logicalId)),
      };
    }
  }

  let bridge: CfnTemplate | undefined;
  try {
    bridge = buildBridgeTemplate(start, renames);
  } catch (error) {
    plan.blockers.push(`Couldn't build the refactor template: ${(error as Error).message}`);
  }
  if (bridge) {
    plan.blockers.push(
      ...verifyBridge(start, bridge, renames).map(
        (problem) => `The refactor template would change more than logical IDs: ${problem}`,
      ),
    );
    const impact = await deployImpact(bridge, v1);
    const notKept = nameNotKept(bridge, v1, input.pins);
    plan.added = impact.added;
    plan.removed = impact.removed.map(notKept);
    plan.replaced = impact.replaced.map(notKept);
    plan.updated = impact.updated;
  }

  plan.ready = bridge !== undefined && stackBlockerCount(plan) === 0;
  return { plan, mapping, renames, ...(bridge && { bridge }), ...(retain && { retain }) };
}

/** How a kept name's resource kind reads in a message. */
const KIND_LABELS: Record<PinnedResourceType, string> = {
  runtime: "runtime",
  "runtime-repository": "runtime ECR repository",
  memory: "memory",
  evaluator: "evaluator",
  "evaluator-function": "evaluator Lambda function",
  "online-eval": "online eval config",
  "policy-engine": "policy engine",
  "config-bundle": "config bundle",
  harness: "harness",
  "harness-role": "harness execution role",
  "harness-repository": "harness ECR repository",
  gateway: "gateway",
  "gateway-target-function": "gateway target Lambda function",
  "gateway-target-runtime": "gateway target runtime",
  "tool-runtime": "tool runtime",
};

/**
 * Rewrites the reason a resource is replaced or deleted when the cause is that the
 * v1 template doesn't render the name the resource is deployed under: it has a
 * kept name, and no v1 resource of its type has that name. `migratedFrom: "v1"`
 * should make the CDK library compose v0's names, so this means v0 naming doesn't
 * reproduce that name.
 */
function nameNotKept(
  bridge: CfnTemplate,
  v1: CfnTemplate,
  pins: PinnedName[],
): (change: StackResourceChange) => StackResourceChange {
  const pinByName = new Map(pins.map((pin) => [pin.value, pin]));
  const deployedResources = resourcesOf(bridge);
  const v1Resources = resourcesOf(v1);
  const v1Names = new Set(
    Object.values(v1Resources).map((resource) =>
      nameKey(resource.Type, resource.Properties?.[NAME_PROPERTIES[resource.Type] ?? ""]),
    ),
  );
  return (change) => {
    if (change.severity !== "blocker") return change;
    const resource = deployedResources[change.logicalId];
    const name = resource?.Properties?.[NAME_PROPERTIES[change.type] ?? ""];
    const pin = typeof name === "string" ? pinByName.get(name) : undefined;
    if (pin === undefined || v1Names.has(nameKey(change.type, name))) return change;
    const rendered =
      v1Resources[change.logicalId]?.Properties?.[NAME_PROPERTIES[change.type] ?? ""];
    const renders =
      typeof rendered === "string"
        ? `v1 renders '${rendered}'`
        : "v1 renders no resource by that name";
    return {
      ...change,
      reason:
        `v0 naming doesn't reproduce ${KIND_LABELS[pin.resourceType]} '${pin.name}' (deployed as ` +
        `'${pin.value}', ${renders}), so the v1 deploy would replace it. Make sure the project's ` +
        '@aws/agentcore-cdk supports migratedFrom: "v1" for this kind of resource.',
    };
  };
}

const nameKey = (type: string, name: unknown) => `${type} ${String(name)}`;

const NESTED_STACK_TYPE = "AWS::CloudFormation::Stack";

/** Renames whose destination is also renamed away from: `A → B` with `B → C`, or a swap. */
export function chainedRenames(renames: ReadonlyMap<string, string>): string[] {
  return [...renames].filter(([, to]) => renames.has(to)).map(([from, to]) => `${from} → ${to}`);
}

export { stackBlockerCount };
