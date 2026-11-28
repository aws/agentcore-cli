import type { RemovedGateway } from "../types";
import type { ProjectMutationResourceType } from "../output";

export const APP_CODE_RETAINED_NOTICE =
  "resource(s) removed from project. Code within app/ directory is left behind.";

export function shouldShowAppCodeNotice(resourceType: ProjectMutationResourceType): boolean {
  return resourceType === "runtime" || resourceType === "harness" || resourceType === "evaluator";
}

/** A gateway of the project, as `remove runtime` reads it before the removal. */
type ProjectGateway = {
  name: string;
  boundRuntime?: string;
  targets: readonly { name: string }[];
};

/**
 * One line for each gateway that `remove runtime` removes with runtime `runtimeName`. Give the
 * project's gateways before the removal: the lines name each gateway bound to the runtime and the
 * names of its targets, because a Box gateway can hold targets the user added, such as MCP
 * servers, and the TUI shows them before they go. Give the removed gateways after the removal:
 * the lines name each gateway and its target count.
 */
export function boundGatewayLines(
  runtimeName: string,
  gateways: readonly (ProjectGateway | RemovedGateway)[],
): string[] {
  return gateways.flatMap((gateway) => {
    if ("targetCount" in gateway) {
      const targets = targetsPhrase(gateway.targetCount);
      return [
        `removed gateway '${gateway.name}'${targets}: it is bound to runtime '${runtimeName}'`,
      ];
    }
    if (gateway.boundRuntime !== runtimeName) return [];
    const names = gateway.targets.map((target) => `'${target.name}'`);
    return [`gateway '${gateway.name}'${targetsPhrase(names.length, names)}`];
  });
}

/** " and its 2 targets", or with `names` " and its targets 'a', 'b'"; empty for no target. */
function targetsPhrase(count: number, names?: readonly string[]): string {
  if (count === 0) return "";
  const noun = count === 1 ? "target" : "targets";
  return names ? ` and its ${noun} ${names.join(", ")}` : ` and its ${count} ${noun}`;
}
