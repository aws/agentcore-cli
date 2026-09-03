import z from "zod";
import { InputValidationError } from "../../../../errors";
import { SourceResolver } from "../../../../io";
import {
  ComponentConfigurationSchema,
  ConfigBundleBranchNameSchema,
  ConfigBundleCommitMessageSchema,
  ConfigBundleDescriptionSchema,
  ConfigBundleNameSchema,
} from "../../../../projectSchemas/config-bundle";
import { KmsKeyArnSchema } from "../../../../projectSchemas/evaluator";
import { createHandler, flag, ProjectKey } from "../../../../router";
import { parseJsonFlagWithSchema } from "../../../utils";
import type { AddProjectResourceConfig } from "../types";

const ComponentsSchema = z
  .record(z.string().min(1), ComponentConfigurationSchema.strict())
  .refine((components) => Object.keys(components).length > 0, {
    message: "must contain at least one component",
  });

export const createAddConfigBundleHandler = (config: AddProjectResourceConfig) =>
  createHandler({
    name: "config-bundle",
    description: "add a configuration bundle to the current project",
    flags: [
      flag("name", "the name of the configuration bundle", ConfigBundleNameSchema.optional()),
      flag(
        "description",
        "a description of the configuration bundle",
        ConfigBundleDescriptionSchema,
      ),
      flag(
        "components",
        "component configuration map (JSON inline, file://<path>, or - for stdin)",
        z.string().optional(),
        { sensitive: true },
      ),
      flag(
        "branch-name",
        "branch name for the initial configuration",
        ConfigBundleBranchNameSchema.default("mainline"),
      ),
      flag(
        "commit-message",
        "message describing the initial configuration",
        ConfigBundleCommitMessageSchema.optional(),
      ),
      flag(
        "kms-key-arn",
        "customer managed KMS key ARN for component configurations",
        KmsKeyArnSchema.optional(),
      ),
    ],
    handle: async (ctx, flags) => {
      if (!flags.name) {
        throw new InputValidationError("required option '--name <name>' not specified");
      }
      if (!flags.components) {
        throw new InputValidationError("required option '--components <components>' not specified");
      }

      const source = new SourceResolver({ stdin: config.io.stdin });
      const componentsText = await source.resolveText("components", flags.components);
      const components = parseJsonFlagWithSchema("components", componentsText, ComponentsSchema);
      if (components === undefined) {
        throw new InputValidationError("required option '--components <components>' not specified");
      }

      const project = ctx.require(ProjectKey);
      for await (const event of config.projectManager.addResource(project, {
        resourceType: "config-bundle",
        resourceConfig: {
          name: flags.name,
          description: flags.description,
          components,
          branchName: flags["branch-name"],
          commitMessage: flags["commit-message"],
          kmsKeyArn: flags["kms-key-arn"],
        },
      })) {
        if (event.type === "step") config.io.stderr.write(`${event.message}\n`);
      }

      config.io.stderr.write(`added configuration bundle '${flags.name}' to '${project.name}'\n`);
    },
  });
