import { createHash } from "node:crypto";
import {
  canonicalJson,
  CDK_METADATA_TYPE,
  dependsOnOf,
  referencesIn,
  resourcesOf,
  stripReferences,
  type CfnTemplate,
} from "./templates";

/**
 * A digest per resource that doesn't depend on logical IDs: the hash of the
 * resource's type, its definition with every reference to another resource
 * replaced by a placeholder, and the digests of the resources it references, in
 * the order it references them. Two templates that differ only in logical IDs
 * (and the references to them) give every resource the same digest; any other
 * difference changes the digest of the resource and of everything that
 * references it.
 *
 * This is the digest the CDK Toolkit's refactoring support computes
 * (`computeResourceDigests` in `@aws-cdk/toolkit-lib`), reimplemented because the
 * Toolkit doesn't export it, and extended to Fn::Sub placeholders.
 */
export function resourceDigests(template: CfnTemplate): Map<string, string> {
  const resources = resourcesOf(template);
  const isResource = (id: string) => id in resources && resources[id]!.Type !== CDK_METADATA_TYPE;
  const digests = new Map<string, string>();
  const visiting = new Set<string>();

  const digestOf = (id: string): string => {
    const known = digests.get(id);
    if (known !== undefined) return known;
    // A cycle makes the template undeployable, so it never reaches a stack; break
    // it with a fixed marker rather than recursing forever.
    if (visiting.has(id)) return "cycle";
    visiting.add(id);
    const { DependsOn: _dependsOn, ...definition } = resources[id]!;
    const metadata = definition.Metadata as Record<string, unknown> | undefined;
    if (metadata && "aws:cdk:path" in metadata) {
      // The construct path names the construct, so it changes with the logical ID.
      const { "aws:cdk:path": _path, ...rest } = metadata;
      definition.Metadata = rest;
    }
    const dependencies = [
      ...referencesIn(definition, isResource).map((ref) => ref.target),
      ...dependsOnOf(resources[id]!).filter(isResource),
    ];
    const hash = createHash("sha256")
      .update(definition.Type)
      .update(canonicalJson(stripReferences(definition, isResource)))
      .update(dependencies.map(digestOf).join(""))
      .digest("hex");
    visiting.delete(id);
    digests.set(id, hash);
    return hash;
  };

  for (const id of Object.keys(resources)) {
    if (isResource(id)) digestOf(id);
  }
  return digests;
}
