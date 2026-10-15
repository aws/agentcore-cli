export { FsProjectManager } from "./manager";
export { CdkBackend, type CdkBackendConfig } from "./backends/cdk";
export { TerraformBackend, type TerraformBackendConfig } from "./backends/terraform";
export type {
  DeployBackendInput,
  ProjectBackend,
  ResolveDeployedResourcesBackendInput,
} from "./backends/types";
