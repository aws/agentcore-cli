import type { ProjectSpec } from "../../../projectSchemas/project";
import type { V0ProjectSpec } from "../../../projectSchemas/v0";

type Json = Record<string, unknown>;

/** v0 named a tool runtime's build type `artifact`; v1 calls it `build`. */
function renameArtifact(compute: unknown): unknown {
  if (typeof compute !== "object" || compute === null) return compute;
  const runtime = (compute as Json).runtime as Json | undefined;
  if (!runtime || !("artifact" in runtime)) return compute;
  const { artifact, ...rest } = runtime;
  return { ...compute, runtime: { ...rest, build: artifact } };
}

/**
 * Maps a v0 spec (already validated by the v0 schema) onto v1's shape.
 *
 * Deliberately not re-validated against v1's schema: compatibility mode accepts
 * whatever v0 accepted, so this only renames and reshapes what v1 reads under
 * another name. Callers that need a valid v1 spec (migrate) validate the result.
 *
 * - `version` becomes 2 and `$schema` is dropped.
 * - `abTests`, `datasets`, `capacityProviders`, `unassignedTargets`, and
 *   `httpGateways` have no v1 equivalent and are dropped from the translated
 *   view. They remain available on `legacy.v0Spec`.
 * - `mcpRuntimeTools` becomes `toolRuntimes`, and every tool runtime's and gateway
 *   target's `compute.runtime.artifact` becomes `build`.
 * - Runtime `capacityProviderVolume` mounts are dropped: v1 has no capacity
 *   providers, and its code switches over the mount kinds it knows.
 */
export function translateV0Spec(v0: V0ProjectSpec): { spec: ProjectSpec } {
  const {
    $schema: _schema,
    abTests: _abTests,
    datasets: _datasets,
    capacityProviders: _capacityProviders,
    unassignedTargets: _unassignedTargets,
    httpGateways: _httpGateways,
    mcpRuntimeTools,
    ...rest
  } = structuredClone(v0) as V0ProjectSpec & Json;

  const runtimes = (rest.runtimes as Json[]).map((runtime) => {
    const mounts = runtime.filesystemConfigurations as Json[] | undefined;
    if (!mounts) return runtime;
    return {
      ...runtime,
      filesystemConfigurations: mounts.filter((mount) => !("capacityProviderVolume" in mount)),
    };
  });
  const agentCoreGateways = (rest.agentCoreGateways as Json[]).map((gateway) => ({
    ...gateway,
    targets: (gateway.targets as Json[]).map((target) =>
      "compute" in target ? { ...target, compute: renameArtifact(target.compute) } : target,
    ),
  }));

  const spec = {
    ...rest,
    version: 2,
    runtimes,
    agentCoreGateways,
    ...(mcpRuntimeTools?.length
      ? {
          toolRuntimes: (mcpRuntimeTools as Json[]).map((tool) => ({
            ...tool,
            compute: renameArtifact(tool.compute),
          })),
        }
      : {}),
  } as unknown as ProjectSpec;

  return { spec };
}
