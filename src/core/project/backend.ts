import type {
  BuildTarget,
  DeploymentTarget,
  Project,
  ProjectProgressEvent,
} from "../../handlers/project/types";

export type BackendBuildResult = {
  cloudAssemblyPath: string;
  targets: BuildTarget[];
};

export type ProjectBuildBackend = {
  readonly name: string;
  build(
    project: Project,
    targets: DeploymentTarget[],
    onProgress?: (event: ProjectProgressEvent) => void,
  ): Promise<BackendBuildResult>;
};
