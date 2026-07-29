import z from "zod";
import { createHandler, flag } from "../../../../../router";
import { InputValidationError } from "../../../../../errors";
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
      flag("name", "the name of the evaluator", z.string().optional()),
      flag("level", `evaluation level (${LEVELS.join(" | ")})`, z.enum(LEVELS).optional()),
      flag("lambda-arn", "ARN of the Lambda function that scores a session", z.string().optional()),
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
      flag("client-token", "idempotency token", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags["name"])
        throw new InputValidationError("required option '--name <name>' not specified");
      if (!flags["level"])
        throw new InputValidationError("required option '--level <level>' not specified");
      if (!flags["lambda-arn"]) {
        throw new InputValidationError("required option '--lambda-arn <lambda-arn>' not specified");
      }

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
          clientToken: flags["client-token"],
        },
        coreOptsFromCtx(ctx),
      );
      ctx.require(JsonRendererKey).renderJson(response);
    },
  });
