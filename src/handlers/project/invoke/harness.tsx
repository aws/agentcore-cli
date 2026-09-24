import { InputValidationError } from "../../../errors";
import type { AppIO } from "../../../io";
import type { Context } from "../../../router";
import { JsonRendererKey, type renderTuiAt } from "../../../tui";
import { runWithProgress } from "../../../tui/progress";
import { JsonKey } from "../../keys";
import { invokeHarnessTurn } from "../../harness/invoke/operation";
import type { Core } from "../../types";
import { coreOptsFromCtx } from "../../utils";
import type { InvokeFlags } from ".";

export async function invokeHarness(
  core: Core,
  io: AppIO,
  ctx: Context,
  harnessId: string,
  flags: InvokeFlags,
  renderInvokeTui: typeof renderTuiAt,
): Promise<void> {
  const sessionId = flags["session-id"];
  if (sessionId !== undefined && (sessionId.length < 33 || sessionId.length > 100)) {
    throw new InputValidationError("--session-id must be 33-100 characters for a harness");
  }

  if (!flags.prompt) {
    if (ctx.require(JsonKey)) {
      throw new InputValidationError("required option '--prompt <text>' not specified");
    }
    let path = `/agentcore/invoke/harness/${encodeURIComponent(harnessId)}`;
    if (sessionId) path += `/${encodeURIComponent(sessionId)}`;
    if (flags.qualifier) path += `?qualifier=${encodeURIComponent(flags.qualifier)}`;
    await renderInvokeTui(path, ctx, core, io);
    return;
  }

  const prompt = flags.prompt;
  const invoke = () =>
    invokeHarnessTurn(
      core.harness,
      { harnessId, prompt, qualifier: flags.qualifier, sessionId },
      coreOptsFromCtx(ctx),
    );
  const result = await runWithProgress(invoke, {
    io,
    label: "Invoking harness...",
    interactive: !ctx.require(JsonKey),
  });
  ctx.require(JsonRendererKey).renderJson(result);
}
