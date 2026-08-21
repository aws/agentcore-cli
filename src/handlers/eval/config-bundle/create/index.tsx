import z from "zod";
import { InputValidationError } from "../../../../errors";
import { SourceResolver, type AppIO } from "../../../../io";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";
import { resolveConfigurationBundleComponents } from "../components";

const BranchNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z][a-zA-Z0-9_/-]{0,127}$/, "Value must match [a-zA-Z][a-zA-Z0-9_/-]");
const CommitMessageSchema = z.string().max(500);

export const createCreateConfigBundleHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "create",
    description: "create a configuration bundle and its initial immutable version",
    flags: [
      flag("name", "the name of the configuration bundle", z.string().optional()),
      flag(
        "components",
        "complete component configuration map (JSON inline, file://<path>, or - for stdin)",
        z.string().optional(),
        { sensitive: true },
      ),
      flag("branch-name", "branch name for the initial configuration", BranchNameSchema.optional()),
      flag(
        "commit-message",
        "message describing the initial configuration",
        CommitMessageSchema.optional(),
      ),
      flag(
        "kms-key-arn",
        "customer managed KMS key ARN for component configurations",
        z.string().optional(),
      ),
    ],
    handle: async (ctx, flags) => {
      if (!flags["name"]) {
        throw new InputValidationError("required option '--name <name>' not specified");
      }
      if (!flags["components"]) {
        throw new InputValidationError("required option '--components <components>' not specified");
      }

      const components = await resolveConfigurationBundleComponents(
        flags["components"],
        new SourceResolver({ stdin: io.stdin }),
      );
      ctx.require(JsonRendererKey).renderJson(
        await core.eval.createConfigurationBundle(
          {
            bundleName: flags["name"],
            components,
            branchName: flags["branch-name"],
            commitMessage: flags["commit-message"],
            kmsKeyArn: flags["kms-key-arn"],
          },
          coreOptsFromCtx(ctx),
        ),
      );
    },
  });
