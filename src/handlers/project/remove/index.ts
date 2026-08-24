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
    flags: [flag("name", "name of the resource to remove", z.string().min(1).optional())],
    arguments: [
      argument("resource", "type of resource to remove", z.enum(["harness", "runtime"]).optional()),
    ],
    handle: async (ctx, flags, args) => {
      const resource = args["resource"];
      const name = flags["name"];
      if (!resource) throw new InputValidationError(`resource argument is required to remove`);
      if (!name) throw new InputValidationError(`--name is required option`);

      await config.projectManager.removeResource(ctx.require(ProjectKey), {
        resourceType: resource,
        name,
      });

      config.io.stdout.write(`removed ${resource} with name '${name}' from project`);
    },
  });
