import z from "zod";
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
import { addProjectResource, requireDeployedNameFits } from "../shared";

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
      flag("name", "the name of the configuration bundle", ConfigBundleNameSchema),
      flag(
        "description",
        "a description of the configuration bundle",
        ConfigBundleDescriptionSchema,
      ),
      flag(
        "components",
        "component configuration map (JSON inline, file://<path>, or - for stdin)",
        z.string().min(1),
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
      const project = ctx.require(ProjectKey);
      requireDeployedNameFits(
        "Configuration bundle",
        project.name,
        flags.name,
        "_",
        100,
        await config.projectManager.listTargets(project),
      );

      const source = new SourceResolver({ stdin: config.io.stdin });
      const componentsText = await source.resolveText("components", flags.components);
      const components = parseJsonFlagWithSchema("components", componentsText, ComponentsSchema);

      await addProjectResource(
        ctx,
        config,
        project,
        {
          resourceType: "config-bundle",
          resourceConfig: {
            name: flags.name,
            description: flags.description,
            components,
            branchName: flags["branch-name"],
            commitMessage: flags["commit-message"],
            kmsKeyArn: flags["kms-key-arn"],
          },
        },
        `added configuration bundle '${flags.name}' to '${project.name}'`,
      );
    },
  });
