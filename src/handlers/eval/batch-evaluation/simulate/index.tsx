import z from "zod";
import { createHandler, flag } from "../../../../router";
import { InputValidationError } from "../../../../errors";
import { JsonRendererKey } from "../../../../tui";
import type { AppIO } from "../../../../io";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";
import { parseRuntimeInvokeHeaders } from "../../../runtime/invoke/request";
import { BatchOutputConfig } from "../outputConfig";

const RUNTIME_INVOCATION = "Runtime invocation:";
const DATASET = "Dataset:";
const CONFIGURATION = "Configuration:";

const payloadTemplateHelp = `(JSON object)
The request body sent to the Runtime for each dataset example. Every occurrence
of {input} is replaced with that example's input, so the template describes the
shape your agent expects and {input} marks where the prompt goes.

Example:
  --payload-template '{"prompt":"{input}"}'

  --payload-template '{"messages":[{"role":"user","content":"{input}"}],"stream":false}'`;

// Composes invokeDataset (replay) → startBatchEvaluation (grade). Invoke flags mirror
// `runtime invoke`.
export const createSimulateBatchEvaluationHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "simulate",
    description: "replay a dataset against a Runtime, then batch-evaluate the resulting sessions",
    flags: [
      flag("runtime-id", "Runtime ID to invoke per scenario", z.string().optional(), {
        group: RUNTIME_INVOCATION,
      }),
      flag("endpoint", "Runtime endpoint qualifier (default DEFAULT)", z.string().optional(), {
        group: RUNTIME_INVOCATION,
      }),
      flag(
        "payload-template",
        "request body per example (JSON object); {input} is replaced with the input",
        z.string().optional(),
        { group: RUNTIME_INVOCATION, help: payloadTemplateHelp },
      ),
      flag("header", "an ordered application header (repeatable)", z.array(z.string()).optional(), {
        group: RUNTIME_INVOCATION,
        sensitive: true,
      }),
      flag(
        "bearer-token",
        "CUSTOM_JWT bearer token (for JWT-auth Runtimes)",
        z.string().optional(),
        { group: RUNTIME_INVOCATION, sensitive: true },
      ),
      flag("user-id", "Runtime user ID", z.string().optional(), {
        group: RUNTIME_INVOCATION,
      }),
      flag("dataset", "dataset source: local JSONL path or a dataset ID", z.string().optional(), {
        group: DATASET,
      }),
      flag("dataset-version", "dataset version (with a dataset ID)", z.string().optional(), {
        group: DATASET,
      }),
      flag(
        "ingestion-wait-ms",
        "ms to wait for span ingestion before grading (default 180000; 0 to skip)",
        z.coerce.number().int().nonnegative().optional(),
        { group: DATASET },
      ),
      flag("name", "batch evaluation name (unique in the account)", z.string().optional(), {
        group: CONFIGURATION,
      }),
      flag("description", "description for the batch evaluation", z.string().optional(), {
        group: CONFIGURATION,
      }),
      flag("kms-key-arn", "KMS key to encrypt evaluation data at rest", z.string().optional(), {
        group: CONFIGURATION,
      }),
      flag("evaluators", "evaluator ID(s) to apply", z.array(z.string()).optional(), {
        group: "Evaluation:",
      }),
      ...BatchOutputConfig.flags,
    ],
    handle: async (ctx, flags) => {
      if (!flags["runtime-id"])
        throw new InputValidationError("required option '--runtime-id' not specified");
      if (!flags["payload-template"]) {
        throw new InputValidationError("required option '--payload-template' not specified");
      }
      if (!flags["dataset"])
        throw new InputValidationError("required option '--dataset' not specified");
      if (!flags["evaluators"]?.length) {
        throw new InputValidationError(
          "required option '--evaluators <evaluators...>' not specified",
        );
      }
      if (!flags["name"])
        throw new InputValidationError("required option '--name <name>' not specified");

      // Ctrl-C aborts the run (invokes, the ingestion wait, the dataset download).
      // TODO(#1986): swap for the shared SIGINT/abort helper once it merges.
      const outputConfig = await BatchOutputConfig.resolve(flags["output-config"], io);

      const controller = new AbortController();
      const interrupt = () => controller.abort();
      process.once("SIGINT", interrupt);
      try {
        const opts = coreOptsFromCtx(ctx);

        const r = await core.eval.invokeDataset(
          {
            runtimeId: flags["runtime-id"],
            qualifier: flags["endpoint"],
            payloadTemplate: flags["payload-template"],
            headers: parseRuntimeInvokeHeaders(flags["header"]),
            bearerToken: flags["bearer-token"],
            userId: flags["user-id"],
            dataset: flags["dataset"],
            datasetVersion: flags["dataset-version"],
            waitIngestionMs: flags["ingestion-wait-ms"],
          },
          opts,
          controller.signal,
        );
        if (r.invoked === 0) {
          const first = r.failures[0];
          const detail = first ? `; first error: ${first.exampleId} — ${first.error}` : "";
          throw new InputValidationError(
            `no examples could be invoked (${r.failed} failed) — nothing to evaluate${detail}`,
          );
        }

        // The example's neutral ground truth crosses over as sessionMetadata (inline arm).
        const job = await core.eval.startBatchEvaluation(
          {
            name: flags["name"],
            description: flags["description"],
            evaluatorIds: flags["evaluators"],
            source: {
              origin: "agent",
              agent: flags["runtime-id"],
              endpoint: flags["endpoint"],
              sessionIds: r.sessions.map((s) => s.sessionId),
            },
            groundTruth: r.sessions.map((s) => ({
              sessionId: s.sessionId,
              testScenarioId: s.exampleId,
              ...(s.groundTruth && { groundTruth: { inline: s.groundTruth } }),
            })),
            kmsKeyArn: flags["kms-key-arn"],
            outputConfig,
          },
          opts,
        );

        ctx.require(JsonRendererKey).renderJson({
          batchEvaluationId: job.batchEvaluationId,
          status: job.status,
          examplesInvoked: r.invoked,
          examplesFailed: r.failed,
          sessions: r.sessions.map((s) => ({ exampleId: s.exampleId, sessionId: s.sessionId })),
          failures: r.failures,
        });
      } finally {
        process.off("SIGINT", interrupt);
      }
    },
  });
