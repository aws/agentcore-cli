import z from "zod";
import { createHandler, flag, ProjectKey } from "../../../../router";
import type { AddProjectResourceConfig } from "../types";
import { addProjectResource } from "../shared";

export const createAddRuntimeEndpointHandler = (config: AddProjectResourceConfig) =>
  createHandler({
    name: "runtime-endpoint",
    description: "add a named endpoint (version alias) to a runtime",
    flags: [
      flag("runtime", "the parent runtime name", z.string().min(1)),
      flag("name", "the endpoint name (e.g., prod, staging)", z.string().min(1)),
      flag(
        "version",
        "the runtime version this endpoint points to (default: 1)",
        z.number().int().min(1).optional(),
      ),
      flag("description", "description of the endpoint", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      const project = ctx.require(ProjectKey);
      const version = flags.version ?? 1;

      await addProjectResource(
        ctx,
        config,
        project,
        {
          resourceType: "runtime-endpoint",
          runtimeName: flags.runtime,
          resourceConfig: {
            name: flags.name,
            version,
            ...(flags.description ? { description: flags.description } : {}),
          },
        },
        `added runtime endpoint '${flags.name}' (version ${version}) to runtime '${flags.runtime}' in '${project.name}'`,
      );
    },
  });
