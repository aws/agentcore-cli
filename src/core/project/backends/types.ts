import type { Project, ProjectEvent } from "../../../handlers/project/types";

/** Builds the deployable artifacts owned by a project's selected backend. */
export interface ProjectBackend {
  build(project: Project): AsyncGenerator<ProjectEvent, void>;
}
