import type {
  DeployResult,
  Project,
  ProjectEvent,
  ResolvedDeployedResource,
  ResolvedProjectResource,
  TeardownConfirmationHandler,
  BoxGatewayDeletionHandler,
} from "../../../handlers/project/types";
import type { AwsDeploymentTarget } from "../../../projectSchemas/aws-targets";
import type { BoxNetwork } from "../boxNetwork";

export type BuildBackendInput = {
  /** The Box network model of each box runtime, which staging writes the Runtime profile from. */
  boxNetworks: readonly BoxNetwork[];
};

export type DeployBackendInput = {
  /** Fully resolved account and region selected from aws-targets.json. */
  target: AwsDeploymentTarget;
  /** Requests approval after synthesis identifies a teardown. */
  confirmTeardown: TeardownConfirmationHandler;
  /** Requests approval for a deploy that would delete the Box gateway; absent means declined. */
  confirmBoxGatewayDeletion?: BoxGatewayDeletionHandler;
  /** Whether to enable CloudWatch Transaction Search on deploy (global config). */
  transactionSearch?: boolean;
  /** Leaves the CDK bootstrap stack alone for accounts bootstrapped outside the CLI. */
  skipBootstrap?: boolean;
} & BuildBackendInput;

export type ResolveDeployedResourcesBackendInput = {
  target: AwsDeploymentTarget;
};

export type ResolveProjectResourcesBackendInput = {
  target: AwsDeploymentTarget;
};

/** Builds the deployable artifacts owned by a project's selected backend. */
export interface ProjectBackend {
  build(project: Project, input: BuildBackendInput): AsyncGenerator<ProjectEvent, void>;
  deploy(project: Project, input: DeployBackendInput): AsyncGenerator<ProjectEvent, DeployResult>;
  resolveDeployedResources(
    project: Project,
    input: ResolveDeployedResourcesBackendInput,
  ): Promise<ResolvedDeployedResource[]>;
  /**
   * Reports every resource the project declares against the target, including the
   * ones it has not deployed.
   *
   * TODO: merge resolveDeployedResources and resolveProjectResources; the two are
   * similar enough that one resolver should serve both invoke and status.
   */
  resolveProjectResources(
    project: Project,
    input: ResolveProjectResourcesBackendInput,
  ): Promise<ResolvedProjectResource[]>;
}
