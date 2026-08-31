import type { GatewayFilter } from "@aws-sdk/client-bedrock-agentcore";
import z from "zod";
import { createHandler, flag } from "../../../../../router";
import { InputValidationError } from "../../../../../errors";
import { JsonRendererKey } from "../../../../../tui";
import { SourceResolver, type AppIO } from "../../../../../io";
import type { Core } from "../../../../types";
import type { BundleRef } from "../../../types";
import { coreOptsFromCtx } from "../../../../utils";
import { parseJsonFlag } from "../../../../utils";

const bundleRefSchema = z
  .object({
    "config-bundle": z.string().min(1),
    "bundle-version": z.string().min(1),
  })
  .strict();

function toBundleRef(name: string, raw: unknown): BundleRef {
  const parsed = bundleRefSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InputValidationError(
      `--${name} must be {"config-bundle": "<id>", "bundle-version": "<version>"}`,
    );
  }
  return {
    configBundle: parsed.data["config-bundle"],
    bundleVersion: parsed.data["bundle-version"],
  };
}

export const createConfigBasedRunHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "run",
    description: "run an A/B test between two config-bundle versions on one gateway",
    flags: [
      flag("name", "the A/B test name", z.string().optional()),
      flag("gateway", "deployed gateway id", z.string().optional()),
      flag(
        "control",
        'control JSON {"config-bundle","bundle-version"} (inline, file://, or -)',
        z.string().optional(),
      ),
      flag(
        "treatment",
        'treatment JSON {"config-bundle","bundle-version"} (inline, file://, or -)',
        z.string().optional(),
      ),
      flag("online-eval", "online-evaluation config id", z.string().optional()),
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
      flag(
        "role-arn",
        "execution-role override (default: auto-provisioned)",
        z.string().optional(),
      ),
      flag(
        "enable-on-create",
        "whether to start the test immediately (default true; pass false to create it paused)",
        z.enum(["true", "false"]).optional(),
      ),
    ],
    handle: async (ctx, flags) => {
      const required = ["name", "gateway", "control", "treatment", "online-eval"] as const;
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
      const gatewayFilter = parseJsonFlag<GatewayFilter>(
        "gateway-filter",
        await source.resolveText("gateway-filter", flags["gateway-filter"]),
      );

      const control = toBundleRef("control", controlRaw);
      const treatment = toBundleRef("treatment", treatmentRaw);
      if (
        control.configBundle === treatment.configBundle &&
        control.bundleVersion === treatment.bundleVersion
      ) {
        throw new InputValidationError(
          "control and treatment must reference a different config-bundle or bundle-version",
        );
      }

      const treatmentWeight = flags["treatment-weight"];
      if (treatmentWeight !== undefined && (treatmentWeight < 1 || treatmentWeight > 99)) {
        throw new InputValidationError("--treatment-weight must be between 1 and 99");
      }

      const result = await core.eval.createConfigBasedABTest(
        {
          name: flags["name"]!,
          gateway: flags["gateway"]!,
          control,
          treatment,
          onlineEval: flags["online-eval"]!,
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
