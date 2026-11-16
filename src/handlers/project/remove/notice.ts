import type { ProjectMutationResourceType } from "../output";

export const APP_CODE_RETAINED_NOTICE =
  "resource(s) removed from project. Code within app/ directory is left behind.";

export function shouldShowAppCodeNotice(resourceType: ProjectMutationResourceType): boolean {
  return resourceType === "runtime" || resourceType === "harness" || resourceType === "evaluator";
}

export const SECURE_VPC_REMOVED_NOTICE =
  "The private VPC setting is removed too, so a runtime added later has an internet path. Create a new project with --isolation private-vpc to get one.";

/** Shown when `remove gateway --name box` removes the entry that holds the Box gateway's targets. */
export const BOX_GATEWAY_STAYS_NOTICE = "The Box gateway stays. This removes only its targets.";
