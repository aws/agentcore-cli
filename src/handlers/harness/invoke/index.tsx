import z from "zod";
import { createHandler, flag, PathKey } from "../../../router";
import { SourceResolver, type AppIO } from "../../../io";
import type { Core } from "../../types.tsx";
import { coreOptsFromCtx } from "../../utils.tsx";
import { JsonKey } from "../../keys.tsx";
import { JsonRendererKey, renderTuiAt } from "../../../tui";
import { runWithProgress } from "../../../tui/progress";
import { InputValidationError, SourceResolutionError } from "../../../errors";
import { invokeHarnessTurn } from "./operation.ts";
import { HarnessInvokeArnKey, HarnessInvokeLaunchContextKey } from "./launchContext";

export const invokeHarnessFlags = [
  flag("id", "the ID of the harness", z.string().min(1).max(51)),
  flag("prompt", "the message to send to the harness", z.string().optional()),
  flag(
    "user-id",
    "the end-user ID for user-scoped AgentCore Identity credentials",
    z.string().optional(),
  ),
  flag(
    "session-id",
    "the Runtime session ID to continue (33-100 characters)",
    z.string().min(33).max(100).optional(),
  ),
  flag(
    "qualifier",
    "the harness endpoint qualifier to invoke (default DEFAULT)",
    z.string().optional(),
  ),
  flag(
    "bearer-token",
    "the CUSTOM_JWT bearer token, from stdin ('-') or a file ('file://<path>')",
    z.string().optional(),
    { sensitive: true },
  ),
] as const;

export const createInvokeHarnessHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "invoke",
    description: "invoke a harness",
    flags: invokeHarnessFlags,
    handle: async (ctx, flags) => {
      // Without a prompt, open the interactive chat at this harness — resuming
      // the given session and targeting the given qualifier when passed. The
      // one-shot CLI transcript below needs --prompt (and is the only shape
      // JSON mode supports).
      if (!flags["prompt"]) {
        if (ctx.require(JsonKey)) {
          throw new InputValidationError("required option '--prompt <text>' not specified");
        }
        if (flags["bearer-token"] !== undefined) {
          throw new InputValidationError("--bearer-token requires --prompt");
        }
        let path = `${ctx.require(PathKey)}/${flags["id"]}`;
        if (flags["session-id"]) path += `/${flags["session-id"]}`;
        if (flags["qualifier"]) path += `?qualifier=${encodeURIComponent(flags["qualifier"])}`;
        await renderTuiAt(
          path,
          ctx.withValue(HarnessInvokeLaunchContextKey, {
            harnessId: flags["id"],
            userId: flags["user-id"],
          }),
          core,
          io,
        );
        return;
      }

      const opts = coreOptsFromCtx(ctx);
      const prompt = flags["prompt"];
      const bearerToken = await resolveBearerToken(flags["bearer-token"], io.stdin);
      const invoke = () =>
        invokeHarnessTurn(
          core.harness,
          {
            harnessId: flags["id"],
            harnessArn: ctx.value(HarnessInvokeArnKey),
            prompt,
            qualifier: flags["qualifier"] ?? "DEFAULT",
            sessionId: flags["session-id"],
            userId: flags["user-id"],
            bearerToken,
          },
          opts,
        );
      const result = await runWithProgress(invoke, {
        io,
        label: "Invoking harness...",
        interactive: !ctx.require(JsonKey),
      });
      ctx.require(JsonRendererKey).renderJson(result);
    },
  });

async function resolveBearerToken(
  source: string | undefined,
  stdin: NodeJS.ReadStream,
): Promise<string | undefined> {
  try {
    return await new SourceResolver({ stdin }).resolveSecret("bearer-token", source);
  } catch (error) {
    if (error instanceof SourceResolutionError) {
      throw new InputValidationError(error.message, { cause: error });
    }
    throw error;
  }
}

export { HarnessInvokeScreen } from "./screen.tsx";
