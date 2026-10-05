import z from "zod";
import { createHandler, flag, ProjectKey } from "../../../../router";
import type { AddResourceInput } from "../../types";
import type { AddProjectResourceConfig } from "../types";
import { addProjectResource, addDescription } from "../shared";

// The version an endpoint points to when none is given — what --version
// documents as its default, and what the wizard prefills.
export const DEFAULT_ENDPOINT_VERSION = 1;

// RuntimeEndpointInput is the endpoint as the flags state it.
export type RuntimeEndpointInput = {
  runtime: string;
  name: string;
  version?: number;
  description?: string;
};

type AddRuntimeEndpoint = Extract<AddResourceInput, { resourceType: "runtime-endpoint" }>;

// toAddRuntimeEndpointInput is the one place a runtime endpoint is built from
// user input — the flags, or the wizard's answers — so both default the version
// and drop an empty description the same way.
export function toAddRuntimeEndpointInput(input: RuntimeEndpointInput): AddRuntimeEndpoint {
  return {
    resourceType: "runtime-endpoint",
    runtimeName: input.runtime,
    resourceConfig: {
      name: input.name,
      version: input.version ?? DEFAULT_ENDPOINT_VERSION,
      ...(input.description ? { description: input.description } : {}),
    },
  };
}

export const createAddRuntimeEndpointHandler = (config: AddProjectResourceConfig) =>
  createHandler({
    name: "runtime-endpoint",
    description: addDescription(
      "runtime-endpoint",
      "add a named endpoint (version alias) to a runtime",
    ),
    flags: [
      flag("runtime", "the parent runtime name", z.string().min(1)),
      flag("name", "the endpoint name (e.g., prod, staging)", z.string().min(1)),
      flag(
        "version",
        `the runtime version this endpoint points to (default: ${DEFAULT_ENDPOINT_VERSION})`,
        z.number().int().min(1).optional(),
      ),
      flag("description", "description of the endpoint", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      const project = ctx.require(ProjectKey);
      const input = toAddRuntimeEndpointInput({
        runtime: flags.runtime,
        name: flags.name,
        version: flags.version,
        description: flags.description,
      });

      await addProjectResource(
        ctx,
        config,
        project,
        input,
        `added runtime endpoint '${flags.name}' (version ${input.resourceConfig.version}) to runtime '${flags.runtime}' in '${project.name}'`,
      );
    },
  });
