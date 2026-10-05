import React from "react";
import { RouterScreen } from "../../../components/RouterScreen";
import { isChinaRegion } from "../../../core/partition";
import { ProjectKey } from "../../../router";
import type { Core, ScreenProps } from "../../types";
import { useProject, useProjectTargets } from "../ProjectGate";
import type { Project } from "../types";
import { CN_UNAVAILABLE_NOTE } from "./shared";

const PATH = ["agentcore", "add"];

/**
 * Shown above the add menu when the project has a China (aws-cn) deployment
 * target. The rows it refers to carry {@link CN_UNAVAILABLE_NOTE}, derived from
 * the project manager's China allowlist, so the menu says which ones; the same
 * allowlist refuses them when their wizard submits.
 */
export const CHINA_ADD_MENU_ALERT =
  `This project deploys to a China (aws-cn) region: the resources marked ` +
  `"${CN_UNAVAILABLE_NOTE}" below are refused there.`;

// AddMenuScreen is the `add` command menu. It is the plain RouterScreen plus a
// China alert: the project and its targets load in the background and the menu
// renders at once without them, so a project without a China target (or no
// project at all) sees exactly the generic menu.
export function AddMenuScreen({ ctx, core }: ScreenProps) {
  const project = useProject(core, ctx.value(ProjectKey));
  if (project.data === undefined) return <RouterScreen ctx={ctx} core={core} path={PATH} />;
  return <ProjectAddMenu ctx={ctx} core={core} project={project.data} />;
}

function ProjectAddMenu({ ctx, core, project }: ScreenProps & { core: Core; project: Project }) {
  const targets = useProjectTargets(core, project);
  const china = targets.data?.some((target) => isChinaRegion(target.region)) ?? false;
  return (
    <RouterScreen
      ctx={ctx}
      core={core}
      path={PATH}
      alert={china ? CHINA_ADD_MENU_ALERT : undefined}
    />
  );
}
