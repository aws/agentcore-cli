import { createInterface } from "node:readline/promises";
import { argument, createHandler, flag, ProjectKey } from "../../../router";
import { InputValidationError, UserCancellationError } from "../../../errors";
import z from "zod";
import type { AppIO } from "../../../io";
import { ENV_LOCAL_RELATIVE_PATH } from "../../../core/project/envLocal";
import { JsonKey } from "../../keys";
import { reportMessage } from "../../utils";
import type { ProjectManager } from "../types";

type RemoveProjectResourceConfig = {
  projectManager: ProjectManager;
  io: AppIO;
};

export const createRemoveProjectHandler = (config: RemoveProjectResourceConfig) =>
  createHandler({
    name: "remove",
    description: "remove a resource from the project",
    flags: [
      flag("name", "name of the resource to remove", z.string().min(1).optional()),
      flag("gateway", "name of the parent Gateway for a Target", z.string().min(1).optional()),
      flag("engine", "name of the parent Policy Engine for a Policy", z.string().min(1).optional()),
      flag(
        "manager",
        "name of the parent payment manager for a connector",
        z.string().min(1).optional(),
      ),
      flag(
        "yes",
        "skip the confirmation prompt when removing all resources",
        z.boolean().default(false),
      ),
    ],
    arguments: [
      argument(
        "resource",
        "type of resource to remove ('all' empties every resource collection)",
        z
          .enum([
            "harness",
            "runtime",
            "credential",
            "config-bundle",
            "online-eval",
            "online-insight",
            "memory",
            "evaluator",
            "gateway",
            "gateway-target",
            "gateway-connector",
            "policy-engine",
            "policy",
            "payment-manager",
            "payment-connector",
            "all",
          ])
          .optional(),
      ),
    ],
    handle: async (ctx, flags, args) => {
      const resource = args["resource"];
      if (!resource) throw new InputValidationError(`resource argument is required to remove`);

      if (flags.gateway && resource !== "gateway-target" && resource !== "gateway-connector") {
        throw new InputValidationError(
          `--gateway is valid only when removing a gateway-target or gateway-connector`,
        );
      }
      if (flags.engine && resource !== "policy") {
        throw new InputValidationError(`--engine is valid only when removing a policy`);
      }
      if (flags.manager && resource !== "payment-connector") {
        throw new InputValidationError(`--manager is valid only when removing a payment-connector`);
      }

      const project = ctx.require(ProjectKey);

      if (resource === "all") {
        if (flags.name) {
          throw new InputValidationError(`--name is not valid when removing all resources`);
        }
        await confirmRemoveAll(config.io, ctx.require(JsonKey), flags.yes, project.name);
        const result = await config.projectManager.removeAllResources(project);
        reportEnvCleanup(config.io, result.removedEnvKeys);
        reportMessage(ctx, config.io, "removed all resources from project");
        return;
      }

      const name = flags["name"];
      if (!name) throw new InputValidationError(`--name is required option`);

      let result;
      if (resource === "gateway-target" || resource === "gateway-connector") {
        if (!flags.gateway) {
          throw new InputValidationError(`--gateway is required option`);
        }
        result = await config.projectManager.removeResource(project, {
          resourceType: "gateway-target",
          gatewayName: flags.gateway,
          name,
        });
      } else if (resource === "policy") {
        result = await config.projectManager.removeResource(project, {
          resourceType: "policy",
          engineName: flags.engine,
          name,
        });
      } else if (resource === "payment-connector") {
        if (!flags.manager) {
          throw new InputValidationError(`--manager is required option`);
        }
        result = await config.projectManager.removeResource(project, {
          resourceType: "payment-connector",
          managerName: flags.manager,
          name,
        });
      } else {
        result = await config.projectManager.removeResource(project, {
          resourceType: resource,
          name,
        });
      }

      reportEnvCleanup(config.io, result.removedEnvKeys);
      reportMessage(ctx, config.io, `removed ${resource} with name '${name}' from project`);
    },
  });

function reportEnvCleanup(io: AppIO, removedEnvKeys: string[]): void {
  for (const key of removedEnvKeys) {
    io.stderr.write(`removed '${key}' from ${ENV_LOCAL_RELATIVE_PATH}\n`);
  }
}

// Mirrors the deploy handler's teardown confirmation: --yes bypasses the
// prompt, a non-interactive session fails rather than proceeding, and a
// decline (or SIGINT) raises UserCancellationError.
async function confirmRemoveAll(
  io: AppIO,
  jsonOutput: boolean,
  confirmed: boolean,
  projectName: string,
): Promise<void> {
  if (confirmed) return;
  const canPrompt = !jsonOutput && io.stdin.isTTY && io.stdout.isTTY && io.stderr.isTTY;
  if (!canPrompt) {
    throw new InputValidationError(
      `removing all resources is destructive; re-run with --yes to confirm non-interactively`,
    );
  }
  if (!(await promptForRemoveAll(io, projectName))) {
    throw new UserCancellationError();
  }
}

async function promptForRemoveAll(io: AppIO, projectName: string): Promise<boolean> {
  const readline = createInterface({ input: io.stdin, output: io.stderr });
  try {
    const cancelled = new Promise<never>((_resolve, reject) => {
      const cancel = () => reject(new UserCancellationError());
      readline.once("SIGINT", cancel);
      readline.once("close", cancel);
    });
    const answer = await Promise.race([
      readline.question(
        `Remove every resource from project '${projectName}'?\n` +
          `This empties each resource collection in agentcore.json; code under app/ is kept. (y/N) `,
      ),
      cancelled,
    ]);
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    readline.close();
  }
}
