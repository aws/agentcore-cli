import z from "zod";
import { InputValidationError } from "../../../../errors";
import {
  KnowledgeBaseNameSchema,
  KnowledgeBaseSchema,
} from "../../../../projectSchemas/knowledge-base";
import { createHandler, flag, ProjectKey } from "../../../../router";
import type { AddResourceInput } from "../../types";
import type { AddProjectResourceConfig } from "../types";
import { addDescription, addProjectResource } from "../shared";

type KnowledgeBaseInput = {
  name: string;
  description?: string;
  dataSources: string[];
  gateway?: string;
};

export function toAddKnowledgeBaseInput(input: KnowledgeBaseInput): AddResourceInput {
  const knowledgeBase = {
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
    dataSources: input.dataSources.map((uri) => ({ type: "S3", uri })),
    ...(input.gateway ? { gateway: input.gateway } : {}),
  };

  const parsed = KnowledgeBaseSchema.safeParse(knowledgeBase);
  if (!parsed.success) {
    throw new InputValidationError(z.prettifyError(parsed.error), { cause: parsed.error });
  }

  return {
    resourceType: "knowledge-base",
    resourceConfig: parsed.data,
  };
}

export const createAddKnowledgeBaseHandler = (config: AddProjectResourceConfig) =>
  createHandler({
    name: "knowledge-base",
    description: addDescription("knowledge-base", "add a Knowledge Base to the current project"),
    flags: [
      flag("name", "the name of the Knowledge Base", KnowledgeBaseNameSchema),
      flag("description", "a description of the Knowledge Base", z.string().max(2048).optional()),
      flag(
        "data-source",
        "S3 URI for a data source (repeatable, or pass multiple values)",
        z.array(z.string().min(1)).min(1),
      ),
      flag(
        "gateway",
        "name of the Gateway that exposes this Knowledge Base",
        z.string().min(1).optional(),
      ),
    ],
    handle: async (ctx, flags) => {
      const project = ctx.require(ProjectKey);
      await addProjectResource(
        ctx,
        config,
        project,
        toAddKnowledgeBaseInput({
          name: flags.name,
          description: flags.description,
          dataSources: flags["data-source"],
          gateway: flags.gateway,
        }),
        `added Knowledge Base '${flags.name}' to '${project.name}'`,
      );
    },
  });
