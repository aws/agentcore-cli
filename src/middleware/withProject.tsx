import type { Project, ProjectManager } from "../handlers/project/types";
import { InputValidationError } from "../errors/errors";
import { ProjectKey, type Middleware } from "../router";

interface WithProjectConfig {
  projectManager: ProjectManager;
  cwd: string;
}

/**
 * Middleware that locates the AgentCore project from the configured working
 * directory and pins it on the context under {@link ProjectKey}.
 * Throws if no project can be found.
 *
 * @param config - Contains the {@link ProjectManager} and the `cwd` to search from.
 */
export function withProject(config: WithProjectConfig): Middleware {
  return (h) => ({
    name: () => h.name(),
    description: () => h.description(),
    flags: () => h.flags(),
    arguments: () => h.arguments(),
    children: () => h.children(),
    handle: async (ctx, flags, args) => {
      const project = await config.projectManager.resolve({ filePath: config.cwd });
      if (!project) {
        throw new InputValidationError(`no AgentCore project found at ${config.cwd}`);
      }
      await h.handle(ctx.withValue<Project>(ProjectKey, project), flags, args);
    },
  });
}
