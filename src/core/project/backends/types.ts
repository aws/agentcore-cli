import type { Project, ProjectEvent } from "../../../handlers/project/types";
import type { AwsTarget } from "../../../projectSchemas/aws-targets";

export type BackendDeployInput = {
  /** The entry from aws-targets.json this deploy ships to. */
  target: AwsTarget;
  /** The resolved AWS region the backend's own tooling makes its calls in. */
  region: string;
};

/**
 * The part of build and deploy that belongs to whichever tool owns a project's
 * deployable artifacts, selected by the project's `managedBy`. A terraform or no-IaC
 * project implements this; nothing above it names a tool.
 */
export interface ProjectBackend {
  build(project: Project): AsyncGenerator<ProjectEvent, void>;
  deploy(project: Project, input: BackendDeployInput): AsyncGenerator<ProjectEvent, void>;
}
