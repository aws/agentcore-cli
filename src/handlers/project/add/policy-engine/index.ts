import z from "zod";
import { InputValidationError } from "../../../../errors";
import type { PolicyEngineSchema } from "../../../../projectSchemas/policy";
import { createHandler, flag, ProjectKey } from "../../../../router";
import { parseTags } from "../../../utils";
import type { AddProjectResourceConfig } from "../types";

export const createAddPolicyEngineHandler = (config: AddProjectResourceConfig) =>
  createHandler({
    name: "policy-engine",
    description: "adds a Policy Engine to the current project",
    flags: [
      flag("name", "the Policy Engine name", z.string().optional()),
      flag("description", "Policy Engine description", z.string().optional()),
      flag("encryption-key-arn", "KMS encryption key ARN", z.string().optional()),
      flag("tags", "tags as repeated key=value or a JSON object", z.array(z.string()).optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags.name) {
        throw new InputValidationError("required option '--name <name>' not specified");
      }
      const project = ctx.require(ProjectKey);

      const engine: z.input<typeof PolicyEngineSchema> = {
        name: flags.name,
        description: flags.description,
        encryptionKeyArn: flags["encryption-key-arn"],
        tags: parseTags(flags.tags),
        policies: [],
      };

      for await (const event of config.projectManager.addResource(project, {
        resourceType: "policy-engine",
        resourceConfig: engine,
      })) {
        config.io.stderr.write(`${event.message}\n`);
      }
      config.io.stderr.write(`added Policy Engine '${flags.name}' to '${project.name}'\n`);
    },
  });
