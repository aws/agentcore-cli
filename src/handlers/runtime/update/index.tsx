import z from "zod";
import { createHandler, flag } from "../../../router";
import { JsonRendererKey } from "../../../tui";
import { InputValidationError } from "../../../errors";
import type { Core } from "../../types";
import { coreOptsFromCtx } from "../../utils";
import { optionsForRuntime, runtimeFlag, runtimeSettingFlags, runtimeSettings } from "../flags";

export const createUpdateRuntimeHandler = (core: Core) =>
  createHandler({
    name: "update",
    description:
      "update a Runtime created with `runtime create` (creates a new version; not tracked by an AgentCore project)",
    flags: [
      runtimeFlag,
      ...runtimeSettingFlags("optional"),
      flag(
        "clear-authorizer-configuration",
        "remove the inbound authorizer, so callers authenticate with AWS IAM",
        z.boolean().default(false),
      ),
    ],
    handle: async (ctx, flags) => {
      const settings = runtimeSettings(flags);
      if (flags["clear-authorizer-configuration"] && settings.authorizerConfiguration) {
        throw new InputValidationError(
          "--clear-authorizer-configuration cannot be combined with --authorizer-configuration",
        );
      }
      const options = optionsForRuntime(flags.runtime, coreOptsFromCtx(ctx));
      const runtimeId = await core.runtime.resolveRuntimeId(flags.runtime, options);
      const response = await core.runtime.updateRuntime(
        {
          runtimeId,
          ...settings,
          ...(flags["clear-authorizer-configuration"] && { authorizerConfiguration: null }),
        },
        options,
      );
      ctx.require(JsonRendererKey).renderJson(response);
    },
  });
