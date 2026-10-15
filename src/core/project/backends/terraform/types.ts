import type { DeployableResource } from "../../../../handlers/project/types";

export type TerraformArtifact = { path: string; hash: string };
export type TerraformAssets = {
  runtimes: Record<string, TerraformArtifact>;
  /** Keys are gateway-name/target-name. */
  gatewayTargets: Record<string, TerraformArtifact>;
};
export type TerraformResourceDescriptor = {
  resourceType: DeployableResource;
  name: string;
  parentName?: string;
};
