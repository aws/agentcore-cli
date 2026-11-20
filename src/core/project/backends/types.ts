import type { LocalWorkloadSources, WorkloadBuilds } from "../../../handlers/project/types";
import type {
  BuildProjectInput,
  DeployResult,
  Project,
  ProjectEvent,
  ResolvedDeployedResource,
  ResolvedProjectResource,
  TeardownConfirmationHandler,
} from "../../../handlers/project/types";
import type { AwsDeploymentTarget } from "../../../projectSchemas/aws-targets";

export type DeployBackendInput = BuildProjectInput & {
  /** Fully resolved account and region selected from aws-targets.json. */
  target: AwsDeploymentTarget;
  /** Requests approval after synthesis identifies a teardown. */
  confirmTeardown: TeardownConfirmationHandler;
  /** Whether to enable CloudWatch Transaction Search on deploy (global config). */
  transactionSearch?: boolean;
  /** Leaves the CDK bootstrap stack alone for accounts bootstrapped outside the CLI. */
  skipBootstrap?: boolean;
  /** Effective workload build modes the manager resolved; resolved here when absent. */
  workloadBuilds?: WorkloadBuilds;
  /** Build sources of the ContainerLocal workloads, resolved with workloadBuilds. */
  localWorkloads?: LocalWorkloadSources;
};

export type ResolveDeployedResourcesBackendInput = {
  target: AwsDeploymentTarget;
};

export type ResolveProjectResourcesBackendInput = {
  target: AwsDeploymentTarget;
};

/** Builds the deployable artifacts owned by a project's selected backend. */
export interface ProjectBackend {
  build(project: Project, input?: BuildProjectInput): AsyncGenerator<ProjectEvent, void>;
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
