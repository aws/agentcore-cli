import type {
  DeployResult,
  Project,
  ProjectEvent,
  TeardownConfirmationHandler,
} from "../../../handlers/project/types";
import type { AwsDeploymentTarget } from "../../../projectSchemas/aws-targets";

export type DeployBackendInput = {
  /** Fully resolved account and region selected from aws-targets.json. */
  target: AwsDeploymentTarget;
  /**
   * Permission to tear the target's stack down when the project no longer
   * declares anything to deploy. Withheld by default: that deploy destroys
   * deployed resources, so it takes saying so.
   */
  confirmTeardown: boolean;
  /** Requests approval after synthesis identifies an otherwise unconfirmed teardown. */
  requestTeardownConfirmation?: TeardownConfirmationHandler;
};

/** Builds the deployable artifacts owned by a project's selected backend. */
export interface ProjectBackend {
  build(project: Project): AsyncGenerator<ProjectEvent, void>;
  deploy(project: Project, input: DeployBackendInput): AsyncGenerator<ProjectEvent, DeployResult>;
}
