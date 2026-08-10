import z from "zod";
import { createHandler, flag } from "../../../../../router";
import { InputValidationError } from "../../../../../errors";
import { JsonRendererKey } from "../../../../../tui";
import type { Core } from "../../../../types";
import { coreOptsFromCtx } from "../../../../utils";

export const createCodeBasedUpdateHandler = (core: Core) =>
  createHandler({
    name: "update",
    description: "update a code-based (Lambda-backed) evaluator",
    flags: [
      flag("id", "the ID of the evaluator to update", z.string().optional()),
      flag("lambda-arn", "ARN of the Lambda function that scores a session", z.string().optional()),
      flag(
        "timeout",
        "Lambda timeout in seconds (1-300)",
        z.number().int().min(1).max(300).optional(),
      ),
      flag("kms-key-arn", "customer managed KMS key ARN for evaluator data", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags["id"]) throw new InputValidationError("required option '--id <id>' not specified");

      const response = await core.eval.updateCodeBasedEvaluator(
        flags["id"],
        {
          lambdaArn: flags["lambda-arn"],
          timeout: flags["timeout"],
          kmsKeyArn: flags["kms-key-arn"],
        },
        coreOptsFromCtx(ctx),
      );
      ctx.require(JsonRendererKey).renderJson(response);
    },
  });
