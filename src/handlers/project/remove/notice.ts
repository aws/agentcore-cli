import type { ProjectMutationResourceType } from "../output";

export const APP_CODE_RETAINED_NOTICE = "Resource removed. Note that any code under app/ is kept.";

export function shouldShowAppCodeNotice(resourceType: ProjectMutationResourceType): boolean {
  return resourceType === "runtime" || resourceType === "harness" || resourceType === "evaluator";
}
