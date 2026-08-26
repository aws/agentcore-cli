import type { RecommendationConfig } from "@aws-sdk/client-bedrock-agentcore";
import z from "zod";
import { InputValidationError } from "../../../../errors";
import { SourceResolver, type AppIO } from "../../../../io";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx, parseJsonFlag, parseTags } from "../../../utils";

const RECOMMENDATION_TYPES = [
  "SYSTEM_PROMPT_RECOMMENDATION",
  "TOOL_DESCRIPTION_RECOMMENDATION",
] as const;

export const createStartRecommendationHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "start",
    description: "start an asynchronous recommendation",
    flags: [
      flag("name", "the name of the recommendation", z.string().optional()),
      flag(
        "type",
        `the recommendation type (${RECOMMENDATION_TYPES.join(" | ")})`,
        z.enum(RECOMMENDATION_TYPES).optional(),
      ),
      flag(
        "recommendation-config",
        "recommendation configuration (JSON inline, file://<path>, or - for stdin)",
        z.string().optional(),
        { sensitive: true },
      ),
      flag("description", "a description of the recommendation", z.string().optional()),
      flag(
        "kms-key-arn",
        "customer managed KMS key ARN for recommendation data",
        z.string().optional(),
      ),
      flag("tags", "tags as key=value (repeatable) or JSON object", z.array(z.string()).optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags["name"]) {
        throw new InputValidationError("required option '--name <name>' not specified");
      }
      if (!flags["type"]) {
        throw new InputValidationError("required option '--type <type>' not specified");
      }
      if (!flags["recommendation-config"]) {
        throw new InputValidationError(
          "required option '--recommendation-config <recommendation-config>' not specified",
        );
      }

      const source = new SourceResolver({ stdin: io.stdin });
      const recommendationConfig = parseJsonFlag<RecommendationConfig>(
        "recommendation-config",
        await source.resolveText("recommendation-config", flags["recommendation-config"]),
      );
      if (!recommendationConfig) {
        throw new InputValidationError(
          "required option '--recommendation-config <recommendation-config>' not specified",
        );
      }

      const response = await core.eval.startRecommendation(
        {
          name: flags["name"],
          type: flags["type"],
          recommendationConfig,
          description: flags["description"],
          kmsKeyArn: flags["kms-key-arn"],
          tags: parseTags(flags["tags"]),
        },
        coreOptsFromCtx(ctx),
      );
      ctx.require(JsonRendererKey).renderJson(response);
    },
  });
