import { ProjectStateError } from "../../../errors";
import type { Project } from "../../../handlers/project/types";

/** Keep v0 projects read-only until the operation-specific compatibility paths land. */
export function assertV1Project(project: Project, command: string): void {
  if (!project.legacy) return;
  throw new ProjectStateError(
    `'${command}' isn't available for v0 projects yet. ` +
      `Use the v0 CLI for now: npx @aws/agentcore@0 ${command} …`,
  );
}
