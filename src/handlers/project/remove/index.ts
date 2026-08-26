import { argument, createHandler, flag, ProjectKey } from "../../../router";
import { InputValidationError } from "../../../errors";
import z from "zod";
import type { AppIO } from "../../../io";
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
    ],
    arguments: [
      argument(
        "resource",
        "type of resource to remove",
        z
          .enum([
            "harness",
            "runtime",
            "gateway",
            "gateway-target",
            "gateway-connector",
            "policy-engine",
            "policy",
          ])
          .optional(),
      ),
    ],
    handle: async (ctx, flags, args) => {
      const resource = args["resource"];
      const name = flags["name"];
      if (!resource) throw new InputValidationError(`resource argument is required to remove`);
      if (!name) throw new InputValidationError(`--name is required option`);

      const project = ctx.require(ProjectKey);
      if (resource === "gateway-target" || resource === "gateway-connector") {
        if (!flags.gateway) {
          throw new InputValidationError(`--gateway is required option`);
        }
        await config.projectManager.removeResource(project, {
          resourceType: "gateway-target",
          gatewayName: flags.gateway,
          name,
        });
      } else if (resource === "policy") {
        await config.projectManager.removeResource(project, {
          resourceType: "policy",
          engineName: flags.engine,
          name,
        });
      } else {
        if (flags.gateway) {
          throw new InputValidationError(
            `--gateway is valid only when removing a gateway-target or gateway-connector`,
          );
        }
        if (flags.engine) {
          throw new InputValidationError(`--engine is valid only when removing a policy`);
        }
        await config.projectManager.removeResource(project, {
          resourceType: resource,
          name,
        });
      }

      config.io.stdout.write(`removed ${resource} with name '${name}' from project`);
    },
  });
