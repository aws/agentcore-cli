import { ProjectStateError } from "../../../errors";
import type { Project } from "../../../handlers/project/types";

/** Guard operations whose implementation rewrites files using the v1 project shape. */
export function assertV1Project(project: Project, command: string): void {
  if (!project.legacy) return;
  throw new ProjectStateError(
    `'${command}' isn't available for v0 projects yet. ` +
      `Use the v0 CLI for now: npx @aws/agentcore@0 ${command} …`,
  );
}
