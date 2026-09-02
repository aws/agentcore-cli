import z from "zod";
import { InputValidationError } from "../../../../errors";
import { SourceResolver } from "../../../../io";
import {
  ComponentConfigurationSchema,
  ConfigBundleBranchNameSchema,
  ConfigBundleCommitMessageSchema,
  ConfigBundleDescriptionSchema,
  ConfigBundleNameSchema,
  type ConfigBundleSchema,
} from "../../../../projectSchemas/config-bundle";
import { KmsKeyArnSchema } from "../../../../projectSchemas/evaluator";
import { createHandler, flag, ProjectKey } from "../../../../router";
import { formatZodError } from "../../../../router/schema";
import { parseJsonFlag } from "../../../utils";
import type { AddResourceInput } from "../../types";
import type { AddProjectResourceConfig } from "../types";

/**
 * The shape --components accepts. Exported so the wizard's components step
 * validates against the same schema rather than a copy of it.
 */
export const ComponentsSchema = z
  .record(z.string().min(1), ComponentConfigurationSchema.strict())
  .refine((components) => Object.keys(components).length > 0, {
    message: "must contain at least one component",
  });

/** The branch the initial configuration lands on when none is named. */
export const DEFAULT_BRANCH_NAME = "mainline";

/**
 * ConfigBundleInput is what every entry point — the flag handler, the wizard —
 * resolves its own inputs to before a bundle is built. `components` is parsed
 * JSON, validated here. Anything optional is a field toAddConfigBundleInput
 * defaults.
 */
export interface ConfigBundleInput {
  name: string;
  /** Parsed JSON; validated against ComponentsSchema here. */
  components: unknown;
  description?: string;
  branchName?: string;
  commitMessage?: string;
  kmsKeyArn?: string;
}

/**
 * toAddConfigBundleInput is the one place a configuration bundle is assembled
 * from user input. Both the flag handler and the wizard call it, so they
 * cannot disagree about what a bundle is or what it defaults to.
 */
export function toAddConfigBundleInput(input: ConfigBundleInput): AddResourceInput {
  const components = ComponentsSchema.safeParse(input.components);
  if (!components.success) {
    throw new InputValidationError(
      `Invalid value for option '--components': ${formatZodError(components.error)}`,
      { cause: components.error },
    );
  }
  const resourceConfig: z.input<typeof ConfigBundleSchema> = {
    name: input.name,
    description: input.description,
    components: components.data,
    branchName: input.branchName ?? DEFAULT_BRANCH_NAME,
    commitMessage: input.commitMessage,
    kmsKeyArn: input.kmsKeyArn,
  };
  return { resourceType: "config-bundle", resourceConfig };
}

export const createAddConfigBundleHandler = (config: AddProjectResourceConfig) =>
  createHandler({
    name: "config-bundle",
    description: "adds a configuration bundle to the current project",
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
    // handle only turns flags into a ConfigBundleInput — resolving the
    // components source and parsing it. What a bundle is belongs to
    // toAddConfigBundleInput.
    handle: async (ctx, flags) => {
      if (!flags.name) {
        throw new InputValidationError("required option '--name <name>' not specified");
      }
      if (!flags.components) {
        throw new InputValidationError("required option '--components <components>' not specified");
      }

      const source = new SourceResolver({ stdin: config.io.stdin });
      const components = parseJsonFlag<unknown>(
        "components",
        await source.resolveText("components", flags.components),
      );

      const input = toAddConfigBundleInput({
        name: flags.name,
        components,
        description: flags.description,
        branchName: flags["branch-name"],
        commitMessage: flags["commit-message"],
        kmsKeyArn: flags["kms-key-arn"],
      });

      const project = ctx.require(ProjectKey);
      for await (const event of config.projectManager.addResource(project, input)) {
        config.io.stderr.write(`${event.message}\n`);
      }

      config.io.stderr.write(`added configuration bundle '${flags.name}' to '${project.name}'\n`);
    },
  });
