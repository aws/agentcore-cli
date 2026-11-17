import { createHandler, flag } from "../../../router";
import { JsonRendererKey } from "../../../tui";
import type { AppIO } from "../../../io";
import { AgentNameSchema } from "../../../projectSchemas/runtime";
import type { Core } from "../../types";
import { JsonKey } from "../../keys";
import { coreOptsFromCtx, parseTags, tagsFlag } from "../../utils";
import { runtimeSettingFlags, runtimeSettings } from "../flags";
import { runtimeParameterHelp } from "../parameterHelp";

export const createCreateRuntimeHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "create",
    description:
      "create a Runtime from a pre-built container image (not tracked by an AgentCore project)",
    flags: [
      flag("name", "the name of the Runtime", AgentNameSchema, {
        help: runtimeParameterHelp.name,
      }),
      ...runtimeSettingFlags("required"),
      tagsFlag(),
    ],
    handle: async (ctx, flags) => {
      const { containerUri, ...settings } = runtimeSettings(flags);
      const response = await core.runtime.createRuntime(
        {
          runtimeName: flags.name,
          containerUri: containerUri!,
          ...settings,
          tags: parseTags(flags.tags),
        },
        coreOptsFromCtx(ctx),
      );
      ctx.require(JsonRendererKey).renderJson(response);
      if (!ctx.require(JsonKey)) {
        io.stderr.write(
          `next steps:\n` +
            `  agentcore runtime get --id ${response.agentRuntimeId}\n` +
            `  agentcore invoke --runtime ${response.agentRuntimeArn}\n`,
        );
      }
    },
  });
