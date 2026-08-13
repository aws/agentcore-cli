import z from "zod";
import { InputValidationError } from "../../../../errors";
import { SourceResolver, type AppIO } from "../../../../io";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";
import { resolveConfigurationBundleComponents } from "../components";

export const createUpdateConfigBundleHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "update",
    description: "create a new immutable configuration bundle version",
    flags: [
      flag("id", "the ID of the configuration bundle", z.string().optional()),
      flag(
        "components",
        "replacement component configuration map (JSON inline, file://<path>, or - for stdin)",
        z.string().optional(),
        { sensitive: true },
      ),
      flag(
        "commit-message",
        "message describing the configuration bundle update",
        z.string().max(500).optional(),
      ),
      flag("branch-name", "branch to update", z.string().default("mainline")),
      flag(
        "kms-key-arn",
        "customer managed KMS key ARN to rotate component encryption to",
        z.string().optional(),
      ),
    ],
    handle: async (ctx, flags) => {
      if (!flags["id"]) {
        throw new InputValidationError("required option '--id <id>' not specified");
      }
      if (!flags["components"]) {
        throw new InputValidationError("required option '--components <components>' not specified");
      }
      if (!flags["commit-message"]) {
        throw new InputValidationError(
          "required option '--commit-message <commit-message>' not specified",
        );
      }

      const components = await resolveConfigurationBundleComponents(
        flags["components"],
        new SourceResolver({ stdin: io.stdin }),
      );
      ctx.require(JsonRendererKey).renderJson(
        await core.eval.updateConfigurationBundle(
          flags["id"],
          {
            branchName: flags["branch-name"],
            components,
            commitMessage: flags["commit-message"],
            kmsKeyArn: flags["kms-key-arn"],
          },
          coreOptsFromCtx(ctx),
        ),
      );
    },
  });
