import z from "zod";
import { InputValidationError } from "../../../../errors";
import { SourceResolver } from "../../../../io";
import type { AwsDeploymentTarget } from "../../../../projectSchemas/aws-targets";
import {
  ComponentConfigurationSchema,
  ConfigBundleBranchNameSchema,
  ConfigBundleCommitMessageSchema,
  ConfigBundleDescriptionSchema,
  ConfigBundleNameSchema,
} from "../../../../projectSchemas/config-bundle";
import { KmsKeyArnSchema } from "../../../../projectSchemas/evaluator";
import { createHandler, flag, ProjectKey } from "../../../../router";
import { formatZodError } from "../../../../router/schema";
import { parseJsonFlag } from "../../../utils";
import type { AddResourceInput, Project } from "../../types";
import type { AddProjectResourceConfig } from "../types";
import { addProjectResource, requireDeployedNameFits } from "../shared";

// ComponentsSchema is the shape --components accepts. The wizard's components
// step validates against it too, rather than a copy of it.
export const ComponentsSchema = z
  .record(z.string().min(1), ComponentConfigurationSchema.strict())
  .refine((components) => Object.keys(components).length > 0, {
    message: "must contain at least one component",
  });

// The branch the initial configuration lands on when none is named.
export const DEFAULT_BRANCH_NAME = "mainline";

// ConfigBundleInput is what either entry point — the flags, or the wizard —
// resolves its answers to. `components` is parsed JSON, validated below;
// anything optional keeps the default the flag path would give it.
export type ConfigBundleInput = {
  name: string;
  components: unknown;
  description?: string;
  branchName?: string;
  commitMessage?: string;
  kmsKeyArn?: string;
};

// toAddConfigBundleInput is the one place a configuration bundle is built from
// user input, so the flags and the wizard cannot disagree about what a bundle
// is, what it defaults to, or how a deployed name is bounded.
export function toAddConfigBundleInput(
  project: Project,
  targets: readonly AwsDeploymentTarget[],
  input: ConfigBundleInput,
): AddResourceInput {
  requireDeployedNameFits("Configuration bundle", project.name, input.name, "_", 100, targets);
  const components = ComponentsSchema.safeParse(input.components);
  if (!components.success) {
    throw new InputValidationError(
      `Invalid value for option '--components': ${formatZodError(components.error)}`,
      { cause: components.error },
    );
  }
  return {
    resourceType: "config-bundle",
    resourceConfig: {
      name: input.name,
      description: input.description,
      components: components.data,
      branchName: input.branchName ?? DEFAULT_BRANCH_NAME,
      commitMessage: input.commitMessage,
      kmsKeyArn: input.kmsKeyArn,
    },
  };
}

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
        ConfigBundleBranchNameSchema.default(DEFAULT_BRANCH_NAME),
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
      const source = new SourceResolver({ stdin: config.io.stdin });
      const components = parseJsonFlag<unknown>(
        "components",
        await source.resolveText("components", flags.components),
      );
      const input = toAddConfigBundleInput(
        project,
        await config.projectManager.listTargets(project),
        {
          name: flags.name,
          components,
          description: flags.description,
          branchName: flags["branch-name"],
          commitMessage: flags["commit-message"],
          kmsKeyArn: flags["kms-key-arn"],
        },
      );

      await addProjectResource(
        ctx,
        config,
        project,
        input,
        `added configuration bundle '${flags.name}' to '${project.name}'`,
      );
    },
  });
