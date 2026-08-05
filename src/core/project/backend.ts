import type {
  BuildArtifact,
  DeploymentTarget,
  Project,
  ProjectProgressEvent,
} from "../../handlers/project/types";

export type BackendBuildResult = {
  artifact: BuildArtifact;
};

export type ProjectBuildBackend = {
  readonly name: string;
  build(
    project: Project,
    targets: DeploymentTarget[],
    onProgress?: (event: ProjectProgressEvent) => void,
  ): Promise<BackendBuildResult>;
};
