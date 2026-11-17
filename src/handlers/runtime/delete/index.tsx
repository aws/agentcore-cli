import { createInterface } from "node:readline/promises";
import z from "zod";
import { createHandler, flag } from "../../../router";
import { JsonRendererKey } from "../../../tui";
import { InputValidationError, UserCancellationError } from "../../../errors";
import type { AppIO } from "../../../io";
import type { Core } from "../../types";
import { JsonKey } from "../../keys";
import { coreOptsFromCtx } from "../../utils";
import { optionsForRuntime, runtimeFlag } from "../flags";

export const createDeleteRuntimeHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "delete",
    description:
      "delete a Runtime created with `runtime create` (not tracked by an AgentCore project)",
    flags: [
      runtimeFlag,
      flag(
        "delete-execution-role",
        "also delete the execution role, if it is the default role the CLI created for this Runtime",
        z.boolean().default(false),
      ),
      flag("yes", "skip the confirmation prompt", z.boolean().default(false)),
    ],
    handle: async (ctx, flags) => {
      const options = optionsForRuntime(flags.runtime, coreOptsFromCtx(ctx));
      const runtimeId = await core.runtime.resolveRuntimeId(flags.runtime, options);
      await confirmDelete(io, ctx.require(JsonKey), flags.yes, runtimeId);
      const response = await core.runtime.deleteRuntime(
        { runtimeId, deleteExecutionRole: flags["delete-execution-role"] },
        options,
      );
      ctx.require(JsonRendererKey).renderJson(response);
      if (response.executionRole && !response.executionRole.deleted && !ctx.require(JsonKey)) {
        io.stderr.write(
          `kept execution role ${response.executionRole.roleArn}: ` +
            "it is not the default role the CLI created for this Runtime\n",
        );
      }
    },
  });

// Mirrors `remove --all`: --yes skips the prompt, a non-interactive session
// fails rather than deleting, and a decline (or SIGINT) cancels.
async function confirmDelete(
  io: AppIO,
  jsonOutput: boolean,
  confirmed: boolean,
  runtimeId: string,
): Promise<void> {
  if (confirmed) return;
  const canPrompt = !jsonOutput && io.stdin.isTTY && io.stdout.isTTY && io.stderr.isTTY;
  if (!canPrompt) {
    throw new InputValidationError(
      `deleting Runtime ${runtimeId} is permanent; re-run with --yes to confirm non-interactively`,
    );
  }
  const readline = createInterface({ input: io.stdin, output: io.stderr });
  try {
    const cancelled = new Promise<never>((_resolve, reject) => {
      const cancel = () => reject(new UserCancellationError());
      readline.once("SIGINT", cancel);
      readline.once("close", cancel);
    });
    const answer = await Promise.race([
      readline.question(
        `Delete Runtime ${runtimeId}? This removes the Runtime, its versions, and its endpoints. (y/N) `,
      ),
      cancelled,
    ]);
    if (!/^(?:y|yes)$/i.test(answer.trim())) throw new UserCancellationError();
  } finally {
    readline.close();
  }
}
