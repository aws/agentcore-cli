import type { Context } from "../../router";
import { JsonRendererKey } from "../../tui";
import { JsonKey } from "../keys";
import type { Project } from "./types";

export type ProjectMutationResource = {
  type: string;
  name?: string;
  parent?: {
    type: string;
    name: string;
  };
};

export type ProjectMutationResult = {
  operation: "create" | "add" | "remove";
  project: {
    name: string;
    path: string;
  };
  resource?: ProjectMutationResource;
  removedEnvironmentKeys?: string[];
};

export function projectReference(project: Project): ProjectMutationResult["project"] {
  return {
    name: project.name,
    path: project.rootPath,
  };
}

export function renderProjectMutationResult(
  ctx: Context,
  result: ProjectMutationResult,
  renderHuman: () => void,
): void {
  if (ctx.require(JsonKey)) {
    ctx.require(JsonRendererKey).renderJson(result);
    return;
  }
  renderHuman();
}
