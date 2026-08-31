import z from "zod";
import { createHandler, flag, PathKey } from "../../../router";
import type { AppIO } from "../../../io";
import type { Core } from "../../types.tsx";
import { coreOptsFromCtx } from "../../utils.tsx";
import { JsonKey } from "../../keys.tsx";
import { JsonRendererKey, renderTuiAt } from "../../../tui";
import { InputValidationError } from "../../../errors";
import { invokeHarnessTurn } from "./operation.ts";

export const createInvokeHarnessHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "invoke",
    description: "invoke a harness",
    flags: [
      flag("id", "the ID of the harness", z.string().max(48).optional()),
      flag("prompt", "the message to send to the harness", z.string().optional()),
      flag(
        "session-id",
        "the runtime session ID to continue (33-100 characters)",
        z.string().min(33).max(100).optional(),
      ),
      flag(
        "qualifier",
        "the harness endpoint qualifier to invoke (default DEFAULT)",
        z.string().optional(),
      ),
    ],
    handle: async (ctx, flags) => {
      // These are required at runtime but declared optional so that a bare
      // `harness invoke` falls through to the TUI middleware instead.
      if (!flags["id"]) {
        throw new InputValidationError("required option '--id <id>' not specified");
      }
      // Without a prompt, open the interactive chat at this harness — resuming
      // the given session and targeting the given qualifier when passed. The
      // one-shot CLI transcript below needs --prompt (and is the only shape
      // JSON mode supports).
      if (!flags["prompt"]) {
        if (ctx.require(JsonKey)) {
          throw new InputValidationError("required option '--prompt <text>' not specified");
        }
        let path = `${ctx.require(PathKey)}/${flags["id"]}`;
        if (flags["session-id"]) path += `/${flags["session-id"]}`;
        if (flags["qualifier"]) path += `?qualifier=${encodeURIComponent(flags["qualifier"])}`;
        await renderTuiAt(path, ctx, core, io);
        return;
      }

      const opts = coreOptsFromCtx(ctx);
      const result = await invokeHarnessTurn(
        core.harness,
        {
          harnessId: flags["id"],
          prompt: flags["prompt"],
          qualifier: flags["qualifier"] ?? "DEFAULT",
          sessionId: flags["session-id"],
        },
        opts,
      );
      ctx.require(JsonRendererKey).renderJson(result);
    },
  });

export { HarnessInvokeScreen } from "./screen.tsx";
