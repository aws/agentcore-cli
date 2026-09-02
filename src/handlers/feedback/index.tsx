import { createInterface } from "node:readline/promises";
import z from "zod";
import { argument, createHandler, flag } from "../../router";
import { JsonRendererKey } from "../../tui";
import { JsonKey } from "../keys.tsx";
import { InputValidationError, UserCancellationError } from "../../errors";
import { CONSENT_TEXT, submitFeedback } from "./submit";
import type { AppIO } from "../../io";
import type { Core } from "../types.tsx";

export const createFeedbackHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "feedback",
    description: "Send feedback about the AgentCore CLI to the team.",
    arguments: [argument("message", "the feedback message to send", z.string())],
    flags: [
      flag(
        "screenshot",
        "path to a PNG or JPG screenshot to attach (max 100MB)",
        z.string().optional(),
      ),
      flag(
        "yes",
        "accept the AWS Customer Agreement and skip the consent prompt",
        z.boolean().default(false),
      ),
    ],
    handle: async (ctx, flags, args) => {
      const screenshotPath = flags["screenshot"];
      if (screenshotPath !== undefined && screenshotPath.trim() === "") {
        throw new InputValidationError("--screenshot requires a file path");
      }

      await confirmConsent(io, ctx.require(JsonKey), flags.yes);

      const result = await submitFeedback(
        {
          message: args["message"],
          screenshot: screenshotPath ? { path: screenshotPath } : undefined,
        },
        core.fetch,
      );

      ctx.require(JsonRendererKey).renderJson({ success: true, ...result });
    },
  });

async function confirmConsent(io: AppIO, jsonOutput: boolean, confirmed: boolean): Promise<void> {
  if (confirmed) return;
  const canPrompt = !jsonOutput && io.stdin.isTTY && io.stdout.isTTY && io.stderr.isTTY;
  if (!canPrompt) {
    throw new InputValidationError(
      "submitting feedback requires accepting the AWS Customer Agreement; re-run with --yes to confirm non-interactively",
    );
  }
  if (!(await promptForConsent(io))) {
    throw new UserCancellationError();
  }
}

async function promptForConsent(io: AppIO): Promise<boolean> {
  const readline = createInterface({ input: io.stdin, output: io.stderr });
  try {
    const cancelled = new Promise<never>((_resolve, reject) => {
      const cancel = () => reject(new UserCancellationError());
      readline.once("SIGINT", cancel);
      readline.once("close", cancel);
    });
    const answer = await Promise.race([
      readline.question(`\n${CONSENT_TEXT}\n\nSubmit feedback? (y/N) `),
      cancelled,
    ]);
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    readline.close();
  }
}
