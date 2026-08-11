import type { Project, ProjectManager } from "../handlers/project/types";
import { ProjectStateError } from "../errors/errors";
import { ProjectKey, type Middleware } from "../router";

interface WithProjectConfig {
  projectManager: ProjectManager;
  /** Directory to search upwards from. Defaults to the cwd at invocation time. */
  cwd?: string;
}

/**
 * Middleware that locates the AgentCore project enclosing the working directory
 * and pins it on the context under {@link ProjectKey}.
 * Throws if no project can be found.
 *
 * @param config - Contains the {@link ProjectManager} and an optional `cwd` to search from.
 */
export function withProject(config: WithProjectConfig): Middleware {
  return (h) => ({
    name: () => h.name(),
    description: () => h.description(),
    flags: () => h.flags(),
    arguments: () => h.arguments(),
    doesSupportTui: () => h.doesSupportTui(),
    children: () => h.children(),
    handle: async (ctx, flags, args) => {
      // Resolved per invocation rather than at wiring time so the cwd the user
      // actually ran in is the one searched.
      const from = config.cwd ?? process.cwd();
      const project = await config.projectManager.resolve({ filePath: from });
      if (!project) {
        throw new ProjectStateError(
          `No AgentCore project found at ${from} or any parent directory ` +
            `(looked for agentcore/agentcore.json). ` +
            `Run 'agentcore project create' to scaffold one.`,
        );
      }
      await h.handle(ctx.withValue<Project>(ProjectKey, project), flags, args);
    },
  });
}
