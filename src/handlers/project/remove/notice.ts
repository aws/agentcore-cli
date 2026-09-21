import type { RemoveResourceInput } from "../types";

type RemovableResourceType = RemoveResourceInput["resourceType"] | "gateway-connector";

export const APP_CODE_RETAINED_NOTICE = "Resource removed. Note that any code under app/ is kept.";

export function shouldShowAppCodeNotice(resourceType: RemovableResourceType): boolean {
  return resourceType === "runtime" || resourceType === "harness" || resourceType === "evaluator";
}
