import z from "zod";
import { createHandler, flag, PathKey } from "../../../router";
import type { AppIO } from "../../../io";
import type { Core } from "../../types.tsx";
import { coreOptsFromCtx } from "../../utils.tsx";
import { JsonKey } from "../../keys.tsx";
import { JsonRendererKey, renderTuiAt } from "../../../tui";
import { InputValidationError } from "../../../errors";
import { applyExecEvent, finishExec, newExecItem } from "../invoke/transcript.tsx";

export const createExecHarnessHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "exec",
    description: "run a shell command in a harness",
    flags: [
      flag("id", "the ID of the harness", z.string().max(48).optional()),
      flag("command", "the shell command to run", z.string().optional()),
      flag(
        "session-id",
        "the Runtime session ID to run in (33-100 characters)",
        z.string().min(33).max(100).optional(),
      ),
      flag(
        "qualifier",
        "the harness endpoint qualifier to run in (default DEFAULT)",
        z.string().optional(),
      ),
      flag(
        "timeout",
        "seconds to wait for the command (1-3600)",
        z.number().min(1).max(3600).optional(),
      ),
    ],
    handle: async (ctx, flags) => {
      // Required at runtime but declared optional so that a bare `harness exec`
      // falls through to the TUI middleware instead.
      if (!flags["id"]) {
        throw new InputValidationError("required option '--id <id>' not specified");
      }
      // Without a command, open the interactive exec screen at this harness —
      // resuming the given session and targeting the given qualifier when
      // passed. The one-shot CLI run below needs --command (and is the only
      // shape JSON mode supports).
      if (!flags["command"]) {
        if (ctx.require(JsonKey)) {
          throw new InputValidationError("required option '--command <command>' not specified");
        }
        let path = `${ctx.require(PathKey)}/${flags["id"]}`;
        if (flags["session-id"]) path += `/${flags["session-id"]}`;
        if (flags["qualifier"]) path += `?qualifier=${encodeURIComponent(flags["qualifier"])}`;
        await renderTuiAt(path, ctx, core, io);
        return;
      }

      const opts = coreOptsFromCtx(ctx);
      const detail = await core.harness.getHarness(flags["id"], opts);

      const response = await core.harness.invokeAgentRuntimeCommand(
        {
          // A harness-managed runtime cannot be addressed by its own runtime
          // ARN; the service expects the harness ARN here.
          agentRuntimeArn: detail.harness?.arn,
          qualifier: flags["qualifier"] ?? "DEFAULT",
          runtimeSessionId: flags["session-id"],
          body: { command: flags["command"], timeout: flags["timeout"] },
        },
        opts,
      );

      const item = newExecItem(flags["command"]);
      for await (const event of response.stream ?? []) {
        applyExecEvent(item, event);
      }
      finishExec(item);

      ctx.require(JsonRendererKey).renderJson({
        sessionId: flags["session-id"] ?? response.runtimeSessionId,
        command: item.command,
        exitCode: item.exitCode,
        status: item.status,
        output: item.output,
      });
    },
  });

export { HarnessExecScreen } from "./screen.tsx";
