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
      "sessionId": "string",              // [required] the session this applies to
      "testScenarioId": "string",         // groups sessions replaying one scenario
      "groundTruth": {                    // exactly one key; only inline today
        "inline": {
          "turns": [                      // the expected exchange, in order
            {
              "input": { "prompt": "string" },
              "expectedResponse": { "text": "string" }
            },
            ...
          ],
          "assertions": [                 // statements the response must satisfy
            { "text": "string" },
            ...
          ],
          "expectedTrajectory": {
            "toolNames": ["string", ...]  // tools the agent should have called
          }
        }
      },
      "metadata": { "string": "string", ... }
    },
    ...
  ]

Example:
  --ground-truth '[{"sessionId":"session-123","groundTruth":{"inline":{"turns":[{"input":{"prompt":"Where is my order?"},"expectedResponse":{"text":"It shipped on Tuesday."}}]}}}]'

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

      // One resolver shared across every stdin-capable flag, so a second `-`
      // (e.g. --ground-truth - --output-config -) is rejected rather than
      // silently reading an empty string after the first drains stdin.
      const resolver = new SourceResolver({ stdin: io.stdin });
      const source = await SessionSource.resolve(flags, resolver);

      const groundTruth = parseJsonFlag<SessionMetadataShape[]>(
        "ground-truth",
        await resolver.resolveText("ground-truth", flags["ground-truth"]),
      );

      const outputConfig = await BatchOutputConfig.resolve(flags["output-config"], resolver);

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
