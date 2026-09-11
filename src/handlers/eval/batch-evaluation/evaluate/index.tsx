import z from "zod";
import { createHandler, flag } from "../../../../router";
import { InputValidationError } from "../../../../errors";
import { JsonRendererKey } from "../../../../tui";
import { SourceResolver, type AppIO } from "../../../../io";
import type { Core } from "../../../types";
import type { SessionMetadataShape } from "@aws-sdk/client-bedrock-agentcore";
import { coreOptsFromCtx, parseJsonFlag } from "../../../utils";
import { SessionSource } from "../../sessionSource";
import { BatchOutputConfig } from "../outputConfig";

const CONFIGURATION = "Configuration:";
const EVALUATION = "Evaluation:";

const groundTruthHelp = `(JSON: list of objects)
Expected answers for the sessions being evaluated, so an evaluator can score a
response against a reference instead of judging it on its own. Each entry names
one session; omit an entry for a session that has no reference answer.

Accepts inline JSON, file://<path>, or - to read stdin.

JSON syntax:
  [
    {
      "sessionId": "string",         // [required] the session the reference applies to
      "testScenarioId": "string",    // groups sessions replaying the same scenario
      "groundTruth": {
        "inline": "string"           // the expected answer
      }
    },
    ...
  ]

Example:
  --ground-truth '[{"sessionId":"session-123","groundTruth":{"inline":"The order shipped on Tuesday."}}]'

  --ground-truth file://ground-truth.json`;

export const createEvaluateBatchEvaluationHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "evaluate",
    description: "evaluate existing sessions service-side (async; returns a job ID)",
    flags: [
      flag("name", "batch evaluation name (must be unique in the account)", z.string().optional(), {
        group: CONFIGURATION,
      }),
      flag("description", "optional description", z.string().optional(), {
        group: CONFIGURATION,
      }),
      flag("kms-key-arn", "KMS key to encrypt evaluation data at rest", z.string().optional(), {
        group: CONFIGURATION,
      }),
      ...SessionSource.flags,
      flag("evaluators", "evaluator ID(s) to apply", z.array(z.string()).optional(), {
        group: EVALUATION,
      }),
      flag(
        "ground-truth",
        "expected answers for the sessions (JSON SessionMetadataShape[])",
        z.string().optional(),
        { group: EVALUATION, help: groundTruthHelp },
      ),
      ...BatchOutputConfig.flags,
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

      const outputConfig = await BatchOutputConfig.resolve(flags["output-config"], io);

      const response = await core.eval.startBatchEvaluation(
        {
          name: flags["name"],
          description: flags["description"],
          evaluatorIds: flags["evaluators"],
          source,
          groundTruth,
          kmsKeyArn: flags["kms-key-arn"],
          outputConfig,
        },
        coreOptsFromCtx(ctx),
      );
      ctx.require(JsonRendererKey).renderJson(response);
    },
  });
