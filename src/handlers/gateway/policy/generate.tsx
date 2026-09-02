import z from "zod";
import { InputValidationError } from "../../../errors";
import { type AppIO, SourceResolver } from "../../../io";
import { createHandler, flag, PathKey } from "../../../router";
import { JsonRendererKey, renderTuiAt } from "../../../tui";
import { runWithProgress } from "../../../tui/progress";
import { JsonKey } from "../../keys";
import type { Core } from "../../types";
import { coreOptsFromCtx, renderJsonError } from "../../utils";
import type { PolicyGenerationResult } from "./types";

export const createGeneratePolicyHandler = (
  core: Core,
  io: AppIO,
  renderGenerateTui: typeof renderTuiAt = renderTuiAt,
) =>
  createHandler({
    name: "generate",
    description: "generate a Cedar policy for a Gateway from a natural-language prompt",
    flags: [
      flag(
        "gateway-id",
        "the ID or ARN of the Gateway the policy applies to",
        z.string().optional(),
      ),
      flag(
        "policy-engine-id",
        "the ID or ARN of the Policy Engine (defaults to the Gateway's attached engine)",
        z.string().optional(),
      ),
      flag(
        "prompt",
        "what the policy should allow or deny (inline, file://<path>, or - for stdin)",
        z.string().optional(),
      ),
      flag(
        "name",
        "name of the generation request (defaults to cli_generation_<timestamp>)",
        z.string().optional(),
      ),
    ],
    handle: async (ctx, flags) => {
      if (!flags["gateway-id"]) {
        throw new InputValidationError("required option '--gateway-id <gateway-id>' not specified");
      }
      const jsonOutput = ctx.require(JsonKey);
      if (
        flags.prompt === undefined &&
        !jsonOutput &&
        flags["policy-engine-id"] === undefined &&
        flags.name === undefined
      ) {
        await renderGenerateTui(
          `${ctx.require(PathKey)}/${encodeURIComponent(flags["gateway-id"])}`,
          ctx,
          core,
          io,
        );
        return;
      }
      if (flags.prompt === undefined) {
        throw new InputValidationError("required option '--prompt <prompt>' not specified");
      }
      const prompt = (await new SourceResolver({ stdin: io.stdin }).resolveText(
        "prompt",
        flags.prompt,
      ))!;

      const generation = core.policy.generatePolicy(
        {
          gatewayId: flags["gateway-id"],
          policyEngineId: flags["policy-engine-id"],
          prompt,
          name: flags.name ?? `cli_generation_${Date.now()}`,
        },
        coreOptsFromCtx(ctx),
      );

      let result: PolicyGenerationResult;
      try {
        result = await runWithProgress(generation, {
          io,
          interactive: jsonOutput ? false : undefined,
        });
      } catch (error) {
        if (jsonOutput) renderJsonError(ctx, error);
        throw error;
      }

      if (jsonOutput) {
        ctx.require(JsonRendererKey).renderJson(result);
        return;
      }
      const statements = result.policies.flatMap((policy) =>
        policy.statement ? [policy.statement.trimEnd()] : [],
      );
      io.stdout.write(`${statements.join("\n\n")}\n`);
    },
  });
