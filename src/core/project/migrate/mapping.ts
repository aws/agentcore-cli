import {
  canonicalJson,
  CDK_METADATA_TYPE,
  dependsOnOf,
  isCustomResource,
  referencesIn,
  resourcesOf,
  stripReferences,
  type CfnResource,
  type CfnTemplate,
  type ResourceReference,
} from "./templates";

/** The path recorded for a DependsOn entry, which no property path can equal. */
const DEPENDS_ON_PATH = "(DependsOn)";

/** How a resource in the deployed template was paired with one in the v1 template. */
export type MatchReason = "name" | "logical-id" | "reference";

export type ResourceMatch = {
  /** Logical ID in the deployed (v0) template. */
  from: string;
  /** Logical ID in the v1 template. */
  to: string;
  type: string;
  reason: MatchReason;
};

export type UnmatchedResource = { logicalId: string; type: string };

export type LogicalIdMapping = {
  /** Every pair of resources that are the same AWS resource, whether or not the logical ID changes. */
  matches: ResourceMatch[];
  /** Deployed resources with no v1 counterpart; the v1 deploy deletes them. */
  onlyInOld: UnmatchedResource[];
  /** v1 resources with no deployed counterpart; the v1 deploy creates them. */
  onlyInNew: UnmatchedResource[];
};

/**
 * The property that holds each resource type's physical name. Two resources of
 * the same type with the same name are the same AWS resource, whatever their
 * logical IDs. IAM policies are deliberately absent: CDK names a DefaultPolicy
 * after its own logical ID, so its PolicyName changes whenever the ID does.
 */
export const NAME_PROPERTIES: Readonly<Record<string, string>> = {
  "AWS::BedrockAgentCore::Runtime": "AgentRuntimeName",
  "AWS::BedrockAgentCore::RuntimeEndpoint": "Name",
  "AWS::BedrockAgentCore::Memory": "Name",
  "AWS::BedrockAgentCore::Gateway": "Name",
  "AWS::BedrockAgentCore::GatewayTarget": "Name",
  "AWS::BedrockAgentCore::Evaluator": "EvaluatorName",
  "AWS::BedrockAgentCore::OnlineEvaluationConfig": "OnlineEvaluationConfigName",
  "AWS::BedrockAgentCore::PolicyEngine": "Name",
  "AWS::BedrockAgentCore::Policy": "Name",
  "AWS::BedrockAgentCore::ConfigurationBundle": "BundleName",
  "AWS::BedrockAgentCore::Harness": "HarnessName",
  "AWS::BedrockAgentCore::BrowserCustom": "Name",
  "AWS::BedrockAgentCore::CodeInterpreterCustom": "Name",
  "AWS::BedrockAgentCore::WorkloadIdentity": "Name",
  "AWS::BedrockAgentCore::PaymentManager": "Name",
  "AWS::BedrockAgentCore::PaymentConnector": "Name",
  "AWS::Lambda::Function": "FunctionName",
  "AWS::IAM::Role": "RoleName",
  "AWS::IAM::ManagedPolicy": "ManagedPolicyName",
  "AWS::ECR::Repository": "RepositoryName",
  "AWS::Logs::LogGroup": "LogGroupName",
  "AWS::CodeBuild::Project": "Name",
  "AWS::S3::Bucket": "BucketName",
  "AWS::KMS::Alias": "AliasName",
  "AWS::SecretsManager::Secret": "Name",
};

/**
 * Whether CloudFormation stack refactoring can move a resource of this type to a
 * new logical ID. Custom resources can't be moved; CDK's metadata resource is
 * never worth moving.
 */
export function isMovable(type: string): boolean {
  return !isCustomResource(type) && type !== CDK_METADATA_TYPE;
}

/**
 * The logical ID renames the bridge template applies: every matched pair whose
 * ID changes and whose type stack refactoring can move.
 */
export function renamesOf(mapping: LogicalIdMapping): Map<string, string> {
  return new Map(
    mapping.matches
      .filter((match) => match.from !== match.to && isMovable(match.type))
      .map((match) => [match.from, match.to]),
  );
}

/**
 * Pairs each resource in the deployed template with the v1 resource that is the
 * same AWS resource, in three passes:
 *
 * 1. Named resources, by type and physical name (see {@link NAME_PROPERTIES}).
 * 2. Remaining resources that keep their logical ID and type.
 * 3. Unnamed resources (IAM roles and policies, Lambda permissions, KMS keys, ...)
 *    through the reference graph, repeated until nothing changes: a resource a
 *    matched resource references at some property path pairs with what its
 *    counterpart references at the same path, and a resource that references a
 *    matched resource (a role's policy, a function's permission) pairs with the
 *    v1 resource that references the counterpart at the same path.
 *
 * When several candidates fit, the one whose own properties agree most wins;
 * a tie leaves them unmatched rather than guessing.
 */
export function mapLogicalIds(
  oldTemplate: CfnTemplate,
  newTemplate: CfnTemplate,
): LogicalIdMapping {
  const oldResources = resourcesOf(oldTemplate);
  const newResources = resourcesOf(newTemplate);
  const forward = new Map<string, ResourceMatch>();
  const backward = new Map<string, string>();
  const match = (from: string, to: string, reason: MatchReason) => {
    forward.set(from, { from, to, type: oldResources[from]!.Type, reason });
    backward.set(to, from);
  };
  const unmatchedOld = () => Object.keys(oldResources).filter((id) => !forward.has(id));
  const unmatchedNew = () => Object.keys(newResources).filter((id) => !backward.has(id));

  // 1. By physical name.
  const byName = (resources: Record<string, CfnResource>, ids: string[]) => {
    const groups = new Map<string, string[]>();
    for (const id of ids) {
      const key = nameKey(resources, id);
      if (key !== undefined) groups.set(key, [...(groups.get(key) ?? []), id]);
    }
    return groups;
  };
  const newByName = byName(newResources, Object.keys(newResources));
  for (const [key, oldIds] of byName(oldResources, Object.keys(oldResources))) {
    const newIds = newByName.get(key) ?? [];
    // Names are unique per type in an account, except for child resources such
    // as gateway targets; those pair up through their parents in pass 3.
    if (oldIds.length === 1 && newIds.length === 1) match(oldIds[0]!, newIds[0]!, "name");
  }

  // 2. Same logical ID and type.
  for (const id of unmatchedOld()) {
    if (!backward.has(id) && newResources[id]?.Type === oldResources[id]!.Type) {
      match(id, id, "logical-id");
    }
  }

  // 3. Through references, to a fixed point.
  const oldRefs = referenceIndex(oldResources);
  const newRefs = referenceIndex(newResources);
  const similarity = (from: string, to: string) =>
    propertySimilarity(oldResources, from, newResources, to);
  for (let progress = true; progress;) {
    progress = false;

    // 3a. What matched resources reference.
    for (const { from, to } of [...forward.values()]) {
      const oldTargets = groupTargets(oldRefs.get(from) ?? [], (id) => !forward.has(id));
      const newTargets = groupTargets(newRefs.get(to) ?? [], (id) => !backward.has(id));
      for (const [slot, oldIds] of oldTargets) {
        const newIds = newTargets.get(slot) ?? [];
        const candidates = oldIds.flatMap((x) =>
          newIds
            .filter((y) => oldResources[x]!.Type === newResources[y]!.Type)
            .map((y) => ({ x, y, score: 1 + similarity(x, y) })),
        );
        for (const pair of assign(candidates)) {
          if (forward.has(pair.x) || backward.has(pair.y)) continue;
          match(pair.x, pair.y, "reference");
          progress = true;
        }
      }
    }

    // 3b. What references matched resources. Only property references count:
    // CDK adds DependsOn widely, so sharing one says little about identity.
    const slots = (refs: ResourceReference[], translate: (id: string) => string | undefined) => {
      const bySlot = new Map<string, Set<string>>();
      for (const ref of refs) {
        const target = translate(ref.target);
        if (target === undefined || ref.path === DEPENDS_ON_PATH) continue;
        const slot = `${ref.path}|${ref.attribute ?? ""}`;
        bySlot.set(slot, new Set([...(bySlot.get(slot) ?? []), target]));
      }
      return bySlot;
    };
    const newIds = unmatchedNew();
    const newSlots = new Map(
      newIds.map((y) => [
        y,
        slots(newRefs.get(y) ?? [], (id) => (backward.has(id) ? id : undefined)),
      ]),
    );
    const candidates = unmatchedOld().flatMap((x) => {
      const oldSlots = slots(oldRefs.get(x) ?? [], (id) => forward.get(id)?.to);
      if (oldSlots.size === 0) return [];
      return newIds.flatMap((y) => {
        if (oldResources[x]!.Type !== newResources[y]!.Type) return [];
        let shared = 0;
        for (const [slot, oldTargets] of oldSlots) {
          const newTargets = newSlots.get(y)!.get(slot);
          if (newTargets === undefined) continue;
          // The same property pointing at different matched resources is evidence
          // against the pair, not merely an absence of evidence for it.
          const same =
            oldTargets.size === newTargets.size &&
            [...oldTargets].every((target) => newTargets.has(target));
          if (!same) return [];
          shared += oldTargets.size;
        }
        // Shared references dominate; property agreement only breaks ties.
        return shared === 0 ? [] : [{ x, y, score: shared * 1000 + similarity(x, y) }];
      });
    });
    for (const pair of assign(candidates)) {
      match(pair.x, pair.y, "reference");
      progress = true;
    }
  }

  const unmatched = (resources: Record<string, CfnResource>, ids: string[]) =>
    ids
      .filter((id) => resources[id]!.Type !== CDK_METADATA_TYPE)
      .map((logicalId) => ({ logicalId, type: resources[logicalId]!.Type }));
  return {
    matches: [...forward.values()],
    onlyInOld: unmatched(oldResources, unmatchedOld()),
    onlyInNew: unmatched(newResources, unmatchedNew()),
  };
}

/** `Type` plus the canonical physical name, for a named resource whose name references no other resource. */
function nameKey(resources: Record<string, CfnResource>, id: string): string | undefined {
  const resource = resources[id]!;
  const property = NAME_PROPERTIES[resource.Type];
  const name = property === undefined ? undefined : resource.Properties?.[property];
  if (name === undefined) return undefined;
  // A name built from another resource's attribute would have to be mapped
  // itself before it could be compared; pass 3 pairs those instead.
  if (referencesIn(name, (ref) => ref in resources).length > 0) return undefined;
  return `${resource.Type}\u0000${canonicalJson(name)}`;
}

/** Each resource's references (properties and DependsOn) to other resources in the template. */
function referenceIndex(resources: Record<string, CfnResource>): Map<string, ResourceReference[]> {
  const isResource = (id: string) => id in resources;
  return new Map(
    Object.entries(resources).map(([id, resource]) => [
      id,
      [
        ...referencesIn(resource.Properties ?? {}, isResource),
        ...dependsOnOf(resource)
          .filter(isResource)
          .map((target) => ({ target, path: DEPENDS_ON_PATH })),
      ],
    ]),
  );
}

/** The still-unmatched targets of `refs`, grouped by where they're referenced from. */
function groupTargets(
  refs: ResourceReference[],
  unmatched: (id: string) => boolean,
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const ref of refs) {
    if (!unmatched(ref.target) || ref.path === DEPENDS_ON_PATH) continue;
    const slot = `${ref.path}|${ref.attribute ?? ""}`;
    const targets = groups.get(slot) ?? [];
    if (!targets.includes(ref.target)) groups.set(slot, [...targets, ref.target]);
  }
  return groups;
}

/** How many top-level properties two resources share exactly, references aside. */
function propertySimilarity(
  oldResources: Record<string, CfnResource>,
  from: string,
  newResources: Record<string, CfnResource>,
  to: string,
): number {
  const strip = (resources: Record<string, CfnResource>, id: string) =>
    Object.fromEntries(
      Object.entries(resources[id]!.Properties ?? {}).map(([key, value]) => [
        key,
        canonicalJson(stripReferences(value, (ref) => ref in resources)),
      ]),
    );
  const a = strip(oldResources, from);
  const b = strip(newResources, to);
  return Object.keys(a).filter((key) => key in b && a[key] === b[key]).length;
}

/**
 * Picks pairs from scored candidates, best first. A pair is taken only when no
 * other open candidate for either side scores as high, so a tie is never
 * resolved by order.
 */
function assign<T extends { x: string; y: string; score: number }>(candidates: T[]): T[] {
  const chosen: T[] = [];
  const usedX = new Set<string>();
  const usedY = new Set<string>();
  const open = [...candidates].sort((a, b) => b.score - a.score);
  for (const pair of open) {
    if (usedX.has(pair.x) || usedY.has(pair.y)) continue;
    const rivals = open.filter(
      (other) =>
        other !== pair &&
        other.score === pair.score &&
        (other.x === pair.x || other.y === pair.y) &&
        !usedX.has(other.x) &&
        !usedY.has(other.y),
    );
    // A tie leaves every resource in it unmatched, including for lower-scored pairs.
    for (const taken of [pair, ...rivals]) {
      usedX.add(taken.x);
      usedY.add(taken.y);
    }
    if (rivals.length === 0) chosen.push(pair);
  }
  return chosen;
}
