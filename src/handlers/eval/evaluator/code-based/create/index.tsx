import z from "zod";
import { createHandler, flag } from "../../../../../router";
import { JsonRendererKey } from "../../../../../tui";
import { SourceResolver, type AppIO } from "../../../../../io";
import type { Core } from "../../../../types";
import { coreOptsFromCtx, parseJsonFlag } from "../../../../utils";
import { LEVELS } from "../../levels";

export const createCodeBasedCreateHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "create",
    description: "create a code-based (Lambda-backed) evaluator",
    flags: [
      flag("name", "the name of the evaluator", z.string().min(1)),
      flag("level", `evaluation level (${LEVELS.join(" | ")})`, z.enum(LEVELS)),
      flag("lambda-arn", "ARN of the Lambda function that scores a session", z.string().min(1)),
      // No default; the service applies its own timeout (60s) when omitted.
      flag(
        "timeout",
        "Lambda timeout in seconds (1-300)",
        z.number().int().min(1).max(300).optional(),
      ),
      flag("kms-key-arn", "customer managed KMS key ARN for evaluator data", z.string().optional()),
      flag(
        "tags",
        "tags to apply (JSON object of key/value strings; inline, file://<path>, or - for stdin)",
        z.string().optional(),
      ),
    ],
    handle: async (ctx, flags) => {
      const source = new SourceResolver({ stdin: io.stdin });
      const tags = parseJsonFlag<Record<string, string>>(
        "tags",
        await source.resolveText("tags", flags["tags"]),
      );

      const response = await core.eval.createEvaluator(
        {
          evaluatorName: flags["name"],
          level: flags["level"],
          evaluatorConfig: {
            codeBased: {
              lambdaConfig: {
                lambdaArn: flags["lambda-arn"],
                lambdaTimeoutInSeconds: flags["timeout"],
              },
            },
          },
          kmsKeyArn: flags["kms-key-arn"],
          tags,
        },
        coreOptsFromCtx(ctx),
      );
      ctx.require(JsonRendererKey).renderJson(response);
    },
  });
