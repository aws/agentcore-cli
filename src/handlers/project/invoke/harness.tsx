import { ExitCode, InputValidationError, SilentCLIError } from "../../../errors";
import { invokeLocalHarness } from "../../../core/dev/localInvoke";
import { DEV_PORTS } from "../../../core/dev/port";
import type { AppIO } from "../../../io";
import type { HarnessRegistryEntry } from "../../../projectSchemas/harness";
import type { Context } from "../../../router";
import { withUserCancellation } from "../../../runnable";
import { runWithProgress } from "../../../tui/progress";
import { foldHarnessTurn } from "../../harness/invoke/operation";
import { JsonKey } from "../../keys";
import { JsonRendererKey } from "../../../tui";
import type { InvokeFlags } from ".";

export async function invokeProjectHarnessLocally(
  io: AppIO,
  ctx: Context,
  harness: HarnessRegistryEntry,
  flags: InvokeFlags,
): Promise<void> {
  if (flags.prompt === undefined) {
    throw new InputValidationError("required option '--prompt <prompt>' not specified", {
      exitCode: ExitCode.USAGE,
    });
  }
  const prompt = flags.prompt;
  const result = await withUserCancellation((signal) =>
    runWithProgress(
      async () => {
        const turn = await invokeLocalHarness(
          {
            port: flags.port ?? DEV_PORTS.HARNESS,
            name: harness.name,
            prompt,
            sessionId: flags["session-id"],
          },
          signal,
        );
        return foldHarnessTurn(prompt, turn.sessionId, turn.events);
      },
      { io, label: "Invoking local harness...", interactive: !ctx.require(JsonKey) },
    ),
  );
  ctx.require(JsonRendererKey).renderJson(result);
  if (result.transcript.some((item) => item.kind === "error")) throw new SilentCLIError();
}
