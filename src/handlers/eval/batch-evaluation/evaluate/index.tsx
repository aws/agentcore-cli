import z from "zod";
import { createHandler, flag } from "../../../../router";
import { InputValidationError } from "../../../../errors";
import { JsonRendererKey } from "../../../../tui";
import { SourceResolver, type AppIO } from "../../../../io";
import type { Core } from "../../../types";
import type { SessionMetadataShape } from "@aws-sdk/client-bedrock-agentcore";
import { coreOptsFromCtx, parseJsonFlag } from "../../../utils";
import { SessionSource } from "../../sessionSource";
import { HELP_GROUP } from "../../helpGroups";

export const createEvaluateBatchEvaluationHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "evaluate",
    description: "evaluate existing sessions service-side (async; returns a job ID)",
    flags: [
      flag("name", "batch evaluation name (must be unique in the account)", z.string().optional(), {
        group: HELP_GROUP.configuration,
      }),
      flag("description", "optional description", z.string().optional(), {
        group: HELP_GROUP.configuration,
      }),
      flag("kms-key-arn", "KMS key to encrypt evaluation data at rest", z.string().optional(), {
        group: HELP_GROUP.configuration,
      }),
      ...SessionSource.flags,
      flag("evaluators", "evaluator ID(s) to apply", z.array(z.string()).optional(), {
        group: HELP_GROUP.evaluation,
      }),
      flag(
        "ground-truth",
        "session ground truth (JSON SessionMetadataShape[]; inline, file://<path>, or -)",
        z.string().optional(),
        { group: HELP_GROUP.evaluation },
      ),
    ],
    examples: [
      {
        description: "Evaluate a Runtime with multiple evaluators",
        command: [
          "agentcore eval batch-evaluation evaluate",
          "--agent my-runtime",
          "--evaluators Builtin.Helpfulness Builtin.Correctness",
          "--name weekly-quality",
        ],
      },
      {
        description: "Evaluate sessions within a UTC time window",
        command: [
          "agentcore eval batch-evaluation evaluate",
          "--agent my-runtime",
          "--start-time 2026-09-01T00:00:00Z",
          "--end-time 2026-09-08T00:00:00Z",
          "--evaluators Builtin.Helpfulness",
          "--name weekly-helpfulness",
        ],
      },
      {
        description: "Evaluate specific sessions from a named Runtime endpoint",
        command: [
          "agentcore eval batch-evaluation evaluate",
          "--agent my-runtime",
          "--endpoint BETA",
          "--session-ids session-123 session-456",
          "--evaluators Builtin.Correctness",
          "--name selected-sessions",
        ],
      },
      {
        description: "Evaluate sessions an online evaluation already sampled",
        command: [
          "agentcore eval batch-evaluation evaluate",
          "--online-eval online-eval-id",
          "--evaluators Builtin.Helpfulness",
          "--name sampled-sessions",
        ],
      },
    ],
    handle: async (ctx, flags) => {
      if (!flags["name"]) {
        throw new InputValidationError("required option '--name <name>' not specified");
      }
      if (!flags["evaluators"] || flags["evaluators"].length === 0) {
        throw new InputValidationError(
          "required option '--evaluators <evaluators...>' not specified",
        );
      }

      const source = await SessionSource.resolve(flags, io);

      const resolver = new SourceResolver({ stdin: io.stdin });
      const groundTruth = parseJsonFlag<SessionMetadataShape[]>(
        "ground-truth",
        await resolver.resolveText("ground-truth", flags["ground-truth"]),
      );

      const response = await core.eval.startBatchEvaluation(
        {
          name: flags["name"],
          description: flags["description"],
          evaluatorIds: flags["evaluators"],
          source,
          groundTruth,
          kmsKeyArn: flags["kms-key-arn"],
        },
        coreOptsFromCtx(ctx),
      );
      ctx.require(JsonRendererKey).renderJson(response);
    },
  });
