import type { RemovedGateway } from "../types";
import type { ProjectMutationResourceType } from "../output";

export const APP_CODE_RETAINED_NOTICE =
  "resource(s) removed from project. Code within app/ directory is left behind.";

export function shouldShowAppCodeNotice(resourceType: ProjectMutationResourceType): boolean {
  return resourceType === "runtime" || resourceType === "harness" || resourceType === "evaluator";
}

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
