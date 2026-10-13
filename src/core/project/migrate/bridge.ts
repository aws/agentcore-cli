import { resourceDigests } from "./digest";
import {
  canonicalJson,
  dependsOnOf,
  renameReferences,
  resourcesOf,
  type CfnResource,
  type CfnTemplate,
} from "./templates";

/**
 * The template a stack refactor moves the deployed stack to: the deployed template
 * with only logical IDs renamed. Each resource in `renames` gets its new key, and
 * every Ref, Fn::GetAtt, Fn::Sub placeholder, and DependsOn entry naming it (in
 * resources, outputs, and conditions) follows. Resource definitions are otherwise
 * untouched, which is what a refactor requires: it moves resources and changes
 * nothing about them. Resources not in `renames` (custom resources among them,
 * since CloudFormation can't move those) keep their IDs.
 *
 * Throws when a rename would land on a logical ID the template already uses.
 */
export function buildBridgeTemplate(
  deployed: CfnTemplate,
  renames: ReadonlyMap<string, string>,
): CfnTemplate {
  const resources = resourcesOf(deployed);
  const keptIds = new Set(Object.keys(resources).filter((id) => !renames.has(id)));
  const seen = new Set<string>();
  for (const [from, to] of renames) {
    if (!(from in resources)) {
      throw new Error(`Can't rename '${from}': the deployed template has no such resource.`);
    }
    if (keptIds.has(to)) {
      // Typically a deployed resource v1 drops, whose ID v1 reuses for another.
      throw new Error(
        `Can't rename '${from}' to '${to}': the deployed ${resources[to]!.Type} '${to}' keeps that logical ID.`,
      );
    }
    if (seen.has(to)) {
      throw new Error(`Can't rename '${from}' to '${to}': another resource is renamed to it too.`);
    }
    seen.add(to);
  }

  const bridged: Record<string, CfnResource> = {};
  for (const [id, resource] of Object.entries(resources)) {
    const renamed = renameReferences(resource, renames) as CfnResource;
    if (resource.DependsOn !== undefined) {
      const ids = dependsOnOf(resource).map((dependency) => renames.get(dependency) ?? dependency);
      renamed.DependsOn = typeof resource.DependsOn === "string" ? ids[0]! : ids;
    }
    bridged[renames.get(id) ?? id] = renamed;
  }

  const template: CfnTemplate = { ...deployed, Resources: bridged };
  if (deployed.Outputs !== undefined) {
    template.Outputs = renameReferences(deployed.Outputs, renames) as CfnTemplate["Outputs"];
  }
  if (deployed.Conditions !== undefined) {
    template.Conditions = renameReferences(
      deployed.Conditions,
      renames,
    ) as CfnTemplate["Conditions"];
  }
  return template;
}

/**
 * Confirms that `bridge` is `deployed` with only logical IDs changed: every
 * deployed resource has a bridge resource under its (possibly renamed) ID with the
 * same digest, nothing extra was added, and the outputs are the same once the
 * renames are undone. Returns what doesn't hold; empty means the bridge is safe
 * to refactor to.
 */
export function verifyBridge(
  deployed: CfnTemplate,
  bridge: CfnTemplate,
  renames: ReadonlyMap<string, string>,
): string[] {
  const problems: string[] = [];
  const before = resourceDigests(deployed);
  const after = resourceDigests(bridge);
  const deployedResources = resourcesOf(deployed);
  const bridgeResources = resourcesOf(bridge);

  for (const [id, resource] of Object.entries(deployedResources)) {
    const bridgeId = renames.get(id) ?? id;
    const counterpart = bridgeResources[bridgeId];
    if (counterpart === undefined) {
      problems.push(`${id} (${resource.Type}) is missing from the bridge template as ${bridgeId}.`);
    } else if (counterpart.Type !== resource.Type) {
      problems.push(`${bridgeId} changes type from ${resource.Type} to ${counterpart.Type}.`);
    } else if (before.get(id) !== after.get(bridgeId)) {
      problems.push(
        `${bridgeId} (${resource.Type}) differs from deployed ${id} beyond its logical ID.`,
      );
    }
  }
  const extra = Object.keys(bridgeResources).length - Object.keys(deployedResources).length;
  if (extra > 0)
    problems.push(`The bridge template has ${extra} more resources than the deployed one.`);

  // Everything outside Resources (outputs, conditions, parameters, rules, ...)
  // must be the deployed section once the renames are undone.
  const inverse = new Map([...renames].map(([from, to]) => [to, from]));
  const sections = new Set([...Object.keys(deployed), ...Object.keys(bridge)]);
  sections.delete("Resources");
  for (const section of [...sections].sort()) {
    if (
      canonicalJson(renameReferences(bridge[section], inverse)) !== canonicalJson(deployed[section])
    ) {
      problems.push(
        `The bridge template's ${section} section differs from the deployed one beyond logical IDs.`,
      );
    }
  }
  return problems;
}
