import { ProjectStateError } from "../../../errors";
import type { Project } from "../../../handlers/project/types";

/** Guard operations whose implementation rewrites files using the v1 project shape. */
export function assertV1Project(project: Project, command: string): void {
  if (!project.legacy) return;
  if (command === "build") {
    throw new ProjectStateError(
      "'build' isn't available for v0 projects because v0 did not expose a standalone build " +
        "command. Run `agentcore migrate` to use the v1 build command.",
    );
  }
  if (command === "deploy") {
    throw new ProjectStateError(
      "v0 projects must be deployed by the v0 compatibility runner. " +
        "Run `agentcore deploy` instead of calling the v1 project manager directly.",
    );
  }
  throw new ProjectStateError(
    `'${command}' isn't available for v0 projects yet. ` +
      `Use the v0 CLI for now: npx @aws/agentcore@0 ${command} …`,
  );
}
