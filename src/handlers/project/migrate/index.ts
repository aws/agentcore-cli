import { ERROR_SOURCE, NotImplementedError, ProjectStateError } from "../../../errors";
import type { ProcessRunner } from "../../../io";
import { createHandler, type Middleware } from "../../../router";
import { enclosingProjectRoot } from "../../../core/project/fsUtils";
import { checkGitGate } from "../../../core/project/migrate/gitGate";
import { projectNotFoundMessage } from "../../../middleware/withProject";
import { JsonKey } from "../../keys";
import { renderJsonError } from "../../utils";

type MigrateProjectHandlerConfig = {
  /** Runs git; injectable so tests can fake it. */
  runner: ProcessRunner;
  /** Directory to search upwards from. Defaults to the cwd at invocation time. */
  cwd?: string;
  middlewares?: Middleware[];
};

export const MIGRATE_NOT_AVAILABLE_MESSAGE = "agentcore migrate isn't available yet.";

export const createMigrateProjectHandler = (config: MigrateProjectHandlerConfig) =>
  createHandler({
    name: "migrate",
    description: "migrate an AgentCore CLI v0 project to the current project format",
    middlewares: config.middlewares,
    handle: async (ctx) => {
      try {
        // Located by its marker file rather than withProject: a v0 project's
        // agentcore.json doesn't parse as a current project spec.
        const from = config.cwd ?? process.cwd();
        const projectRoot = enclosingProjectRoot(from);
        if (!projectRoot) throw new ProjectStateError(projectNotFoundMessage(from));

        await checkGitGate(config.runner, projectRoot);

        throw new NotImplementedError(MIGRATE_NOT_AVAILABLE_MESSAGE, {
          source: ERROR_SOURCE.USER,
        });
      } catch (error) {
        if (ctx.require(JsonKey)) renderJsonError(ctx, error);
        throw error;
      }
    },
  });
