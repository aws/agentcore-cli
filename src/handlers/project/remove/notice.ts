import type { RemovedGateway } from "../types";
import type { ProjectMutationResourceType } from "../output";

export const APP_CODE_RETAINED_NOTICE =
  "resource(s) removed from project. Code within app/ directory is left behind.";

export function shouldShowAppCodeNotice(resourceType: ProjectMutationResourceType): boolean {
  return resourceType === "runtime" || resourceType === "harness" || resourceType === "evaluator";
}

export const SECURE_VPC_REMOVED_NOTICE =
  "The private VPC setting is removed too, so a runtime added later has an internet path. Create a new project with --isolation private-vpc to get one.";

/** One line for each gateway removed with runtime `runtimeName`, with its target count. */
export function removedGatewayLines(runtimeName: string, gateways: RemovedGateway[]): string[] {
  return gateways.map(({ name, targetCount }) => {
    const targets =
      targetCount === 0
        ? ""
        : ` and its ${targetCount === 1 ? "1 target" : `${targetCount} targets`}`;
    return `removed gateway '${name}'${targets}: it is bound to runtime '${runtimeName}'`;
  });
}

/**
 * One line for each gateway that `remove runtime` would remove with runtime `runtimeName`, with
 * the names of its targets. The TUI shows it before the removal: a Box gateway can hold targets
 * the user added, such as MCP servers, and they go with the runtime.
 */
export function boundGatewayWarningLines(
  runtimeName: string,
  gateways: readonly {
    name: string;
    boundRuntime?: string;
    targets: readonly { name: string }[];
  }[],
): string[] {
  return gateways
    .filter((gateway) => gateway.boundRuntime === runtimeName)
    .map(({ name, targets }) => {
      const names = targets.map((target) => `'${target.name}'`).join(", ");
      const what =
        targets.length === 0
          ? ""
          : ` and its ${targets.length === 1 ? "target" : "targets"} ${names}`;
      return `gateway '${name}'${what}`;
    });
}
