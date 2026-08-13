import z from "zod";
import { InputValidationError } from "../../../../errors";
import { SourceResolver, type AppIO } from "../../../../io";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";
import { resolveConfigurationBundleComponents } from "../components";

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
            kmsKeyArn: flags["kms-key-arn"],
          },
          coreOptsFromCtx(ctx),
        ),
      );
    },
  });
