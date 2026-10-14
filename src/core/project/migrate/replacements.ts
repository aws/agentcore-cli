import type {
  StackChangeSeverity,
  StackResource,
  StackResourceChange,
} from "../../../handlers/project/migrate/types";
import { NAME_PROPERTIES } from "./mapping";
import { RETAINABLE_TYPES } from "./retain";
import {
  CDK_METADATA_TYPE,
  isCustomResource,
  referencesIn,
  resourcesOf,
  substituteReferences,
  type CfnResource,
  type CfnTemplate,
} from "./templates";

/**
 * CloudFormation only tells you what a deploy replaces once you run it. Predicting
 * it from the templates (with the AWS resource specification) lets migrate block a
 * plan that would lose a runtime, memory, or dataset before anything changes.
 */
/** What the first v1 deploy after the refactor does to the stack's resources. */
export type DeployImpact = {
  added: StackResource[];
  removed: StackResourceChange[];
  replaced: StackResourceChange[];
  /** AgentCore resources the deploy changes in place (property updates, not replacements). */
  updated: StackResourceChange[];
};

const AGENTCORE_TYPE_PREFIX = "AWS::BedrockAgentCore::";

/**
 * Types whose replacement loses something the migration promises to keep, beyond
 * AgentCore resources: a container runtime's ECR repository holds its images and
 * its pinned name.
 */
const KEPT_TYPES = new Set(["AWS::ECR::Repository"]);

/**
 * Types that hold data or secure other resources: deleting or replacing one loses
 * its contents (a KMS key is scheduled for deletion, which breaks whatever it
 * encrypts). Unless retained, losing one blocks the migration.
 */
const STATEFUL_TYPES = new Set([
  "AWS::S3::Bucket",
  "AWS::DynamoDB::Table",
  "AWS::DynamoDB::GlobalTable",
  "AWS::KMS::Key",
  "AWS::Logs::LogGroup",
  "AWS::SecretsManager::Secret",
]);
const STATEFUL_PREFIXES = ["AWS::RDS::", "AWS::EFS::"];

function isStateful(type: string): boolean {
  return STATEFUL_TYPES.has(type) || STATEFUL_PREFIXES.some((prefix) => type.startsWith(prefix));
}

/**
 * Types the v0 CDK app creates that hold no data, so deleting or replacing one
 * only recreates it. Any other type is one migrate can't vouch for: losing it
 * blocks the migration, since only a customized app would have created it.
 */
const STATELESS_TYPES = new Set([
  "AWS::IAM::Role",
  "AWS::IAM::Policy",
  "AWS::IAM::ManagedPolicy",
  "AWS::Lambda::Function",
  "AWS::Lambda::Permission",
  "AWS::Lambda::Version",
  "AWS::Lambda::Alias",
  "AWS::Lambda::EventInvokeConfig",
  "AWS::CodeBuild::Project",
  "AWS::KMS::Alias",
  "AWS::EC2::SecurityGroup",
  "AWS::EC2::SecurityGroupIngress",
  "AWS::EC2::SecurityGroupEgress",
]);

/**
 * AgentCore properties a resource can't change after creation even though the
 * resource specification calls the change an in-place update: the service rejects
 * the update ("Protocol type cannot be updated for an existing gateway"), so the
 * deploy fails and rolls back.
 */
const SERVICE_IMMUTABLE_PROPERTIES: Readonly<Record<string, readonly string[]>> = {
  "AWS::BedrockAgentCore::Gateway": ["ProtocolType", "AuthorizerType"],
};

/** DeletionPolicy values that keep the resource in the account when the stack drops it. */
const RETAINING_POLICIES = new Set(["Retain", "RetainExceptOnCreate"]);

/**
 * Custom resources whose provider does nothing worth keeping on delete: CDK's
 * JSON helper, and the container build trigger, whose recreation just rebuilds
 * the image.
 */
function isHarmlessCustomResource(logicalId: string, type: string): boolean {
  return type === "Custom::AWSCDKCfnJson" || /ContainerBuildTrigger/.test(logicalId);
}

type Diff = typeof import("@aws-cdk/cloudformation-diff");

/**
 * Compares the bridge template (the deployed stack once the refactor has moved
 * it) with the v1 template, the way `cdk diff` does, and reports what the first
 * v1 deploy would create, delete, and replace. Replacement comes from the AWS
 * resource specification: a change to a create-only property replaces the
 * resource. A replaced resource gets a new physical ID, so a resource that reads
 * that ID in a create-only property is replaced too; those are found by diffing
 * each referencing resource against itself with the reference changed.
 */
export async function deployImpact(bridge: CfnTemplate, v1: CfnTemplate): Promise<DeployImpact> {
  // Loaded on first use: the diff library reads a large resource database.
  const diff = await import("@aws-cdk/cloudformation-diff");
  const impact: DeployImpact = { added: [], removed: [], replaced: [], updated: [] };
  const harnessRoles = rolesUsedByHarnesses(bridge, v1);
  const bridgeResources = resourcesOf(bridge);
  const v1Resources = resourcesOf(v1);
  const replacedIds = new Set<string>();

  diff.fullDiff(bridge, v1).resources.forEachDifference((logicalId, change) => {
    const oldType = change.oldResourceType;
    const newType = change.newResourceType;
    if ((oldType ?? newType) === CDK_METADATA_TYPE) return;
    if (oldType !== undefined && newType !== undefined && oldType !== newType) {
      // v1 reuses the logical ID for another kind of resource, which CloudFormation
      // rejects ("Update of resource type is not permitted"), whatever the type.
      impact.removed.push({
        logicalId,
        type: oldType,
        severity: "blocker",
        reason: `the v1 template declares a ${newType} under this logical ID; CloudFormation can't change a resource's type under one logical ID, so the deploy would fail`,
      });
      impact.added.push({ logicalId, type: newType });
    } else if (change.isAddition) {
      impact.added.push({ logicalId, type: newType! });
    } else if (change.isRemoval) {
      const deployed = bridgeResources[logicalId];
      impact.removed.push(
        removal(logicalId, oldType!, isRetained(deployed), deployed?.DeletionPolicy),
      );
    } else if (isReplacement(diff, change.changeImpact)) {
      const properties = Object.entries(change.propertyUpdates)
        .filter(([, update]) => isReplacement(diff, update.changeImpact))
        .map(([name]) => name);
      replacedIds.add(logicalId);
      impact.replaced.push(
        replacement(logicalId, newType!, {
          because: properties.length === 0 ? "" : ` because ${changes(properties)}`,
          conditional: change.changeImpact === diff.ResourceImpact.MAY_REPLACE,
          harnessRole: harnessRoles.has(logicalId),
          keptName: keptCustomName(bridgeResources[logicalId], v1Resources[logicalId]),
        }),
      );
    } else if (newType?.startsWith(AGENTCORE_TYPE_PREFIX)) {
      const updates = Object.entries(change.propertyUpdates).map(([name, diff]) => ({
        name,
        before: diff.oldValue,
        after: diff.newValue,
      }));
      if (updates.length > 0) impact.updated.push(update(logicalId, newType, updates));
    }
  });

  // Follow replacements through references until nothing more is replaced.
  const bridgeIds = new Set(Object.keys(bridgeResources));
  for (let progress = true; progress;) {
    progress = false;
    for (const [logicalId, resource] of Object.entries(v1Resources)) {
      if (replacedIds.has(logicalId) || !bridgeIds.has(logicalId)) continue;
      const cause = referencesIn(resource.Properties ?? {}, (id) => replacedIds.has(id))[0];
      if (!cause) continue;
      const probe = cascadeProbe(diff, logicalId, resource, replacedIds);
      if (!probe) continue;
      replacedIds.add(logicalId);
      // A cascaded replacement supersedes any in-place update reported for it.
      impact.updated = impact.updated.filter((entry) => entry.logicalId !== logicalId);
      impact.replaced.push(
        replacement(logicalId, resource.Type, {
          because: ` because it references ${cause.target}, which is replaced`,
          conditional: probe === "may",
          harnessRole: harnessRoles.has(logicalId),
          keptName: keptCustomName(bridgeResources[logicalId], resource),
        }),
      );
      progress = true;
    }
  }

  impact.removed = impact.removed.map((entry) =>
    sameNameAddition(entry, bridgeResources, v1Resources, impact.added),
  );
  // Replacing a stateful resource: say what happens to the deployed one.
  impact.replaced = impact.replaced.map((entry) =>
    entry.reason.endsWith(STATEFUL_REPLACEMENT)
      ? { ...entry, reason: entry.reason + replacedFate(bridgeResources[entry.logicalId]) }
      : entry,
  );
  return impact;
}

/** The end of a stateful resource's replacement reason, completed by {@link replacedFate}. */
const STATEFUL_REPLACEMENT = "the new one starts empty";

/** What a replacement does with the deployed resource, by its UpdateReplacePolicy. */
function replacedFate(resource: CfnResource | undefined): string {
  switch (resource?.UpdateReplacePolicy) {
    case "Retain":
      return ", and the deployed one is left in the account outside the stack (UpdateReplacePolicy: Retain), unused";
    case "Snapshot":
      return ", and the deployed one is deleted after a final snapshot (UpdateReplacePolicy: Snapshot)";
    default:
      return ", and the deployed one is deleted with its data";
  }
}

/**
 * How to keep a stateful resource the v1 template drops. Retention is read from the
 * deployed template, so the policy only has to reach the stack once: the app is
 * changed back before migrating, and the app check passes again.
 */
const RETAIN_STEPS =
  "To keep it: 1. set its removal policy to retain in agentcore/cdk/lib/cdk-stack.ts (for " +
  "example `application.node.findChild(...)` then `applyRemovalPolicy(RemovalPolicy.RETAIN)`), " +
  "2. run agentcore deploy (it deploys a v0 project with the v0 CLI), 3. undo the change to cdk-stack.ts, " +
  "4. run agentcore migrate again; the deployed stack keeps the policy, so the v1 deploy leaves " +
  "it in the account";

/** Whether the deployed resource's DeletionPolicy keeps it in the account when the stack drops it. */
function isRetained(resource: CfnResource | undefined): boolean {
  return (
    typeof resource?.DeletionPolicy === "string" && RETAINING_POLICIES.has(resource.DeletionPolicy)
  );
}

/** The resource's literal physical name, when its type takes one and it's set to a plain string. */
function literalName(resource: CfnResource | undefined): string | undefined {
  if (resource === undefined) return undefined;
  const value = resource.Properties?.[NAME_PROPERTIES[resource.Type] ?? ""];
  return typeof value === "string" ? value : undefined;
}

/**
 * The custom name a replaced resource keeps: CloudFormation creates the replacement
 * before deleting the original, so it can't replace a resource whose custom name
 * stays the same, and the deploy fails.
 */
function keptCustomName(
  deployed: CfnResource | undefined,
  v1: CfnResource | undefined,
): string | undefined {
  const name = literalName(deployed);
  return name !== undefined && name === literalName(v1) ? name : undefined;
}

/**
 * A deleted resource whose name a resource the deploy creates takes: CloudFormation
 * creates the new resource first, while the old one still holds the name, so the
 * create fails (and a retained one keeps the name for good).
 */
function sameNameAddition(
  entry: StackResourceChange,
  bridgeResources: Record<string, CfnResource>,
  v1Resources: Record<string, CfnResource>,
  added: StackResource[],
): StackResourceChange {
  const name = literalName(bridgeResources[entry.logicalId]);
  if (name === undefined) return entry;
  const taker = added.find(
    (addition) =>
      addition.type === entry.type && literalName(v1Resources[addition.logicalId]) === name,
  );
  if (taker === undefined) return entry;
  return {
    ...entry,
    severity: "blocker",
    reason:
      `the v1 deploy creates ${taker.logicalId} with the same name '${name}' while this one ` +
      "still holds it, so the create fails; the mapping couldn't pair the two",
  };
}

type PropertyUpdate = { name: string; before: unknown; after: unknown };

const shown = (value: unknown) => (value === undefined ? "(unset)" : JSON.stringify(value));

function update(logicalId: string, type: string, updates: PropertyUpdate[]): StackResourceChange {
  const immutable = updates.filter((property) =>
    (SERVICE_IMMUTABLE_PROPERTIES[type] ?? []).includes(property.name),
  );
  if (immutable.length > 0) {
    const listed = immutable
      .map(
        (property) => `${property.name} from ${shown(property.before)} to ${shown(property.after)}`,
      )
      .join(", ");
    return {
      logicalId,
      type,
      severity: "blocker",
      reason:
        `the v1 deploy changes ${listed}, which the service doesn't allow on an existing resource, ` +
        "so the deploy would fail and roll back. Set the matching field in agentcore.json so v1 " +
        'keeps the deployed value (for a gateway: protocolType "None" when ProtocolType is unset, ' +
        "and authorizerType to the deployed AuthorizerType)",
    };
  }
  return {
    logicalId,
    type,
    severity: "warning",
    reason: `the v1 deploy updates it in place: ${changes(updates.map((property) => property.name))}`,
  };
}

function isReplacement(diff: Diff, impact: string | undefined): boolean {
  return impact === diff.ResourceImpact.WILL_REPLACE || impact === diff.ResourceImpact.MAY_REPLACE;
}

/**
 * Whether a new physical ID for any of `replacedIds` replaces `resource`: diffs
 * the resource against itself with those references changed from one stand-in
 * value to another, so the resource specification decides.
 */
function cascadeProbe(
  diff: Diff,
  logicalId: string,
  resource: CfnResource,
  replacedIds: ReadonlySet<string>,
): "will" | "may" | undefined {
  const isReplaced = (id: string) => replacedIds.has(id);
  const before = substituteReferences(resource, isReplaced, "physical-id-before");
  const after = substituteReferences(resource, isReplaced, "physical-id-after");
  const change = diff
    .fullDiff({ Resources: { [logicalId]: before } }, { Resources: { [logicalId]: after } })
    .resources.get(logicalId);
  if (change?.changeImpact === diff.ResourceImpact.WILL_REPLACE) return "will";
  if (change?.changeImpact === diff.ResourceImpact.MAY_REPLACE) return "may";
  return undefined;
}

/** IAM roles a harness runs as, in either template; a harness role keeps its pinned name. */
function rolesUsedByHarnesses(...templates: CfnTemplate[]): Set<string> {
  const roles = new Set<string>();
  for (const template of templates) {
    const resources = resourcesOf(template);
    for (const resource of Object.values(resources)) {
      if (resource.Type !== "AWS::BedrockAgentCore::Harness") continue;
      const isRole = (id: string) => resources[id]?.Type === "AWS::IAM::Role";
      for (const ref of referencesIn(resource.Properties ?? {}, isRole)) roles.add(ref.target);
    }
  }
  return roles;
}

function changes(properties: string[]): string {
  return `${properties.join(", ")} ${properties.length === 1 ? "changes" : "change"}`;
}

/** A Snapshot DeletionPolicy still deletes the resource; only a final snapshot is kept. */
function snapshotNote(policy: unknown): string {
  return policy === "Snapshot" ? " (DeletionPolicy: Snapshot keeps only a final snapshot)" : "";
}

function removal(
  logicalId: string,
  type: string,
  retained: boolean,
  policy?: unknown,
): StackResourceChange {
  const change = (severity: StackChangeSeverity, reason: string) => ({
    logicalId,
    type,
    severity,
    reason,
  });
  if (RETAINABLE_TYPES.has(type)) {
    return retained
      ? change(
          "info",
          "v1 has no counterpart; it's retained, so the v1 deploy leaves it, and its data, in the account outside the stack, where v1 no longer manages it",
        )
      : change(
          "blocker",
          "v1 has no counterpart, and migrate couldn't plan keeping it, so the v1 deploy would delete it and its data",
        );
  }
  if (type.startsWith(AGENTCORE_TYPE_PREFIX) || KEPT_TYPES.has(type)) {
    return change(
      "blocker",
      retained
        ? "the v1 template has no counterpart; it's retained, so the v1 deploy leaves it in the account outside the stack, where v1 no longer manages it"
        : "the v1 template has no counterpart, so the v1 deploy would delete it",
    );
  }
  if (retained) {
    return change(
      "info",
      "the v1 template no longer declares it; it's retained, so it stays in the account outside the stack",
    );
  }
  if (isCustomResource(type)) {
    return isHarmlessCustomResource(logicalId, type)
      ? change(
          "info",
          "custom resources can't be moved; the v1 deploy recreates it under its v1 logical ID",
        )
      : change(
          "warning",
          "custom resources can't be moved; the v1 deploy deletes it (running its provider's delete) and creates its v1 counterpart",
        );
  }
  if (isStateful(type)) {
    return change(
      "blocker",
      `the v1 template has no counterpart, so the v1 deploy would delete it and its data${snapshotNote(policy)}. ${RETAIN_STEPS}`,
    );
  }
  if (!STATELESS_TYPES.has(type)) {
    return change(
      "blocker",
      "the v1 template has no counterpart, so the v1 deploy would delete it, and migrate can't " +
        `tell whether this type holds data${snapshotNote(policy)}. ${RETAIN_STEPS}; or remove it with the v0 CLI before migrating`,
    );
  }
  return change("warning", "the v1 template has no counterpart, so the v1 deploy deletes it");
}

function replacement(
  logicalId: string,
  type: string,
  details: { because: string; conditional: boolean; harnessRole: boolean; keptName?: string },
): StackResourceChange {
  const verb = details.conditional ? "may replace" : "replaces";
  const change = (severity: StackChangeSeverity, consequence: string) => ({
    logicalId,
    type,
    severity,
    reason: `the v1 deploy ${verb} it${details.because}; ${consequence}`,
  });
  if (type.startsWith(AGENTCORE_TYPE_PREFIX)) {
    return change("blocker", "its ID, ARN, and data would be lost");
  }
  if (type === "AWS::ECR::Repository") {
    return change("blocker", "its images and repository URI would be lost");
  }
  if (details.harnessRole) {
    return change("blocker", "the harness's role would get a new name and ARN");
  }
  if (details.keptName !== undefined) {
    return change(
      "blocker",
      `CloudFormation can't replace a resource that keeps its custom name ('${details.keptName}'), so the deploy would fail`,
    );
  }
  if (isCustomResource(type)) {
    return change("warning", "its provider runs again");
  }
  if (isStateful(type)) {
    // Completed by replacedFate() once the deployed resource's policy is known.
    return change("blocker", STATEFUL_REPLACEMENT);
  }
  if (!STATELESS_TYPES.has(type)) {
    return change(
      "blocker",
      "migrate can't tell whether this type holds data; a resource the v0 CDK app doesn't create",
    );
  }
  return change("warning", "resources that use it are updated to the new one");
}
