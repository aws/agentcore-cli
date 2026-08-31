import { createInterface } from "node:readline/promises";
import z from "zod";
import { UserCancellationError } from "../../../errors/errors";
import type { AppIO } from "../../../io";
import { DEFAULT_TARGET_NAME } from "../../../projectSchemas/aws-targets";
import { createHandler, flag, ProjectKey } from "../../../router";
import { JsonRendererKey } from "../../../tui";
import { JsonKey, RegionKey } from "../../keys";
import type {
  ProjectManager,
  TeardownConfirmationRequest,
  TeardownConfirmationHandler,
} from "../types";

type DeployProjectHandlerConfig = {
  projectManager: ProjectManager;
  io: AppIO;
};

export const createDeployProjectHandler = (config: DeployProjectHandlerConfig) =>
  createHandler({
    name: "deploy",
    description: "deploy the project to AWS",
    flags: [
      flag(
        "target",
        "name of the aws-targets.json entry to deploy; the default target is created " +
          "automatically from your AWS account and region on first deploy",
        z.string().default(DEFAULT_TARGET_NAME),
      ),
      flag(
        "yes",
        "confirm removing the target's stack when the project declares nothing to deploy",
        z.boolean().default(false),
      ),
    ],
    handle: async (ctx, flags) => {
      // withProject has already resolved the enclosing project.
      const project = ctx.require(ProjectKey);
      const jsonOutput = ctx.require(JsonKey);
      const canPrompt =
        !flags.yes &&
        !jsonOutput &&
        config.io.stdin.isTTY &&
        config.io.stdout.isTTY &&
        config.io.stderr.isTTY;

      // Progress goes to stderr, keeping stdout for machine output. Driven by
      // hand rather than `for await` because the outputs we render below are the
      // generator's return value, which `for await` discards.
      const deployment = config.projectManager.deploy(project, {
        target: flags.target,
        region: ctx.require(RegionKey),
        confirmTeardown: createTeardownConfirmationHandler(config.io, flags.yes, canPrompt),
      });
      let next = await deployment.next();
      while (!next.done) {
        config.io.stderr.write(`${next.value.message}\n`);
        next = await deployment.next();
      }
      const result = next.value;

      config.io.stderr.write(
        result.tornDown
          ? `Removed project '${project.name}' from target '${flags.target}'\n`
          : `Deployed project '${project.name}' to target '${flags.target}'\n`,
      );
      if (jsonOutput) {
        ctx.require(JsonRendererKey).renderJson(result);
        return;
      }
      for (const [key, value] of Object.entries(result.outputs).sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        config.io.stdout.write(`${key}: ${value}\n`);
      }
    },
  });

function createTeardownConfirmationHandler(
  io: AppIO,
  confirmed: boolean,
  canPrompt: boolean,
): TeardownConfirmationHandler {
  if (confirmed) return async () => true;
  if (!canPrompt) return async () => false;

  return async (request) => {
    if (!(await promptForTeardown(io, request))) {
      throw new UserCancellationError();
    }
    return true;
  };
}

async function promptForTeardown(
  io: AppIO,
  request: TeardownConfirmationRequest,
): Promise<boolean> {
  const readline = createInterface({ input: io.stdin, output: io.stderr });
  try {
    const cancelled = new Promise<never>((_resolve, reject) => {
      const cancel = () => reject(new UserCancellationError());
      readline.once("SIGINT", cancel);
      readline.once("close", cancel);
    });
    const answer = await Promise.race([
      readline.question(
        `Project '${request.projectName}' declares no resources to deploy.\n` +
          `Delete ${request.resourceDescription} from target ` +
          `'${request.targetName}' (${request.account}/${request.region})? (y/N) `,
      ),
      cancelled,
    ]);
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    readline.close();
  }
}
