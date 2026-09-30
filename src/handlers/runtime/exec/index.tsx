import z from "zod";
import { InputValidationError } from "../../../errors";
import type { AppIO } from "../../../io";
import { createHandler, flag, PathKey } from "../../../router";
import { JsonRendererKey, renderTuiAt } from "../../../tui";
import { applyExecEvent, finishExec, newExecItem } from "../../harness/invoke/transcript";
import { JsonKey } from "../../keys";
import type { Core } from "../../types";
import { coreOptsFromCtx } from "../../utils";
import { runtimeIdSchema } from "../invoke/request";

export const createRuntimeExecHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "exec",
    description: "run a shell command in a Runtime",
    flags: [
      flag("id", "the ID of the Runtime", runtimeIdSchema),
      flag(
        "command",
        "the command to run",
        z
          .string()
          .refine((s) => s.trim().length > 0, "command must not be empty")
          .optional(),
      ),
      flag("qualifier", "the endpoint qualifier (default DEFAULT)", z.string().min(1).optional()),
      flag("session-id", "the Runtime session ID", z.string().min(33).max(100).optional()),
      flag(
        "timeout",
        "command timeout in seconds (1-3600)",
        z.number().int().min(1).max(3600).optional(),
      ),
    ],
    handle: async (ctx, flags) => {
      if (flags.command === undefined) {
        if (ctx.require(JsonKey)) {
          throw new InputValidationError("required option '--command <command>' not specified");
        }
        let path = `${ctx.require(PathKey)}/${encodeURIComponent(flags.id)}`;
        if (flags.qualifier) path += `/${encodeURIComponent(flags.qualifier)}`;
        const search = new URLSearchParams();
        if (flags["session-id"]) search.set("session-id", flags["session-id"]);
        if (flags.timeout !== undefined) search.set("timeout", String(flags.timeout));
        await renderTuiAt(search.size ? `${path}?${search}` : path, ctx, core, io);
        return;
      }

      const opts = coreOptsFromCtx(ctx);
      const detail = await core.runtime.getRuntime(flags.id, opts);
      if (!detail.agentRuntimeArn) throw new InputValidationError("Runtime returned no ARN");
      const response = await core.runtime.invokeAgentRuntimeCommand(
        {
          agentRuntimeArn: detail.agentRuntimeArn,
          qualifier: flags.qualifier ?? "DEFAULT",
          runtimeSessionId: flags["session-id"],
          body: { command: flags.command, timeout: flags.timeout },
        },
        opts,
      );
      const item = newExecItem(flags.command);
      for await (const event of response.stream ?? []) applyExecEvent(item, event);
      finishExec(item);
      ctx.require(JsonRendererKey).renderJson({
        sessionId: response.runtimeSessionId ?? flags["session-id"],
        command: item.command,
        exitCode: item.exitCode,
        status: item.status,
        output: item.output,
      });
    },
  });

export { RuntimeExecScreen } from "./screen";
