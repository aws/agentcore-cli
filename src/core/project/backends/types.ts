import type {
  DeployResult,
  Project,
  ProjectEvent,
  ResolvedDeployedResource,
  TeardownConfirmationHandler,
} from "../../../handlers/project/types";
import type { AwsDeploymentTarget } from "../../../projectSchemas/aws-targets";

export type DeployBackendInput = {
  /** Fully resolved account and region selected from aws-targets.json. */
  target: AwsDeploymentTarget;
  /** Requests approval after synthesis identifies a teardown. */
  confirmTeardown: TeardownConfirmationHandler;
};

export type ResolveDeployedResourcesBackendInput = {
  target: AwsDeploymentTarget;
  /** When true, an undeployed target yields [] instead of throwing. */
  allowMissing?: boolean;
};

/** Builds the deployable artifacts owned by a project's selected backend. */
export interface ProjectBackend {
  build(project: Project): AsyncGenerator<ProjectEvent, void>;
  deploy(project: Project, input: DeployBackendInput): AsyncGenerator<ProjectEvent, DeployResult>;
  resolveDeployedResources(
    project: Project,
    input: ResolveDeployedResourcesBackendInput,
  ): Promise<ResolvedDeployedResource[]>;
}
