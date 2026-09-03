import z from "zod";
import { createHandler, flag } from "../../../../../router";
import { InputValidationError } from "../../../../../errors";
import { JsonRendererKey } from "../../../../../tui";
import { SourceResolver, type AppIO } from "../../../../../io";
import type { Core } from "../../../../types";
import type { TargetVariantRef } from "../../../types";
import { coreOptsFromCtx, parseJsonFlag } from "../../../../utils";

const targetRefSchema = z
  .object({
    "gateway-target": z.string().min(1),
    "online-eval": z.string().min(1),
  })
  .strict();

function toTargetRef(name: string, raw: unknown): TargetVariantRef {
  const parsed = targetRefSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InputValidationError(
      `--${name} must be {"gateway-target": "<name>", "online-eval": "<id>"}`,
    );
  }
  return { gatewayTarget: parsed.data["gateway-target"], onlineEval: parsed.data["online-eval"] };
}

export const createTargetBasedRunHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "run",
    description: "run an A/B test between two Gateway Targets and their online evaluations",
    flags: [
      flag("name", "the A/B test name", z.string().optional()),
      flag("gateway", "deployed Gateway ID", z.string().optional()),
      flag(
        "control",
        'control JSON {"gateway-target":"<name>","online-eval":"<id>"} (inline, file://, or -)',
        z.string().optional(),
      ),
      flag(
        "treatment",
        'treatment JSON {"gateway-target":"<name>","online-eval":"<id>"} (inline, file://, or -)',
        z.string().optional(),
      ),
      flag(
        "treatment-weight",
        "1-99; control weight = 100 - this (default 50)",
        z.number().int().optional(),
      ),
      flag(
        "gateway-filter",
        'GatewayFilter JSON, e.g. {"targetPaths":["/orders"]} (inline, file://, or -)',
        z.string().optional(),
      ),
      flag("role-arn", "execution-role override (default auto-provisioned)", z.string().optional()),
      flag(
        "enable-on-create",
        "whether to start the test immediately (default true; pass false to create it paused)",
        z.enum(["true", "false"]).optional(),
      ),
    ],
    handle: async (ctx, flags) => {
      const required = ["name", "gateway", "control", "treatment"] as const;
      for (const f of required) {
        if (!flags[f]) throw new InputValidationError(`required option '--${f}' not specified`);
      }

      const source = new SourceResolver({ stdin: io.stdin });
      const controlRaw = parseJsonFlag<unknown>(
        "control",
        await source.resolveText("control", flags["control"]),
      );
      const treatmentRaw = parseJsonFlag<unknown>(
        "treatment",
        await source.resolveText("treatment", flags["treatment"]),
      );
      const gatewayFilter = parseJsonFlag<
        import("@aws-sdk/client-bedrock-agentcore").GatewayFilter
      >("gateway-filter", await source.resolveText("gateway-filter", flags["gateway-filter"]));

      const control = toTargetRef("control", controlRaw);
      const treatment = toTargetRef("treatment", treatmentRaw);
      if (control.gatewayTarget === treatment.gatewayTarget) {
        throw new InputValidationError(
          "control and treatment must reference different Gateway Targets",
        );
      }

      const treatmentWeight = flags["treatment-weight"];
      if (treatmentWeight !== undefined && (treatmentWeight < 1 || treatmentWeight > 99)) {
        throw new InputValidationError("--treatment-weight must be between 1 and 99");
      }

      const result = await core.eval.createTargetBasedABTest(
        {
          name: flags["name"]!,
          gateway: flags["gateway"]!,
          control,
          treatment,
          treatmentWeight,
          gatewayFilter,
          roleArn: flags["role-arn"],
          enableOnCreate:
            flags["enable-on-create"] === undefined
              ? undefined
              : flags["enable-on-create"] === "true",
        },
        coreOptsFromCtx(ctx),
      );

      ctx.require(JsonRendererKey).renderJson(result);
    },
  });
