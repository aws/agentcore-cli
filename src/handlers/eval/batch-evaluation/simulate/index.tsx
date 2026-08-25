import z from "zod";
import { createHandler, flag } from "../../../../router";
import { InputValidationError } from "../../../../errors";
import { JsonRendererKey } from "../../../../tui";
import type { AppIO } from "../../../../io";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";
import { parseRuntimeInvokeHeaders } from "../../../runtime/invoke/request";

// Composes invokeDataset (replay) → startBatchEvaluation (grade). Invoke flags mirror
// `runtime invoke`.
export const createSimulateBatchEvaluationHandler = (core: Core, _io: AppIO) =>
  createHandler({
    name: "simulate",
    description: "replay a dataset against a runtime, then batch-evaluate the resulting sessions",
    flags: [
      flag("runtime-id", "runtime id to invoke per scenario", z.string().optional()),
      flag("qualifier", "runtime endpoint qualifier (default DEFAULT)", z.string().optional()),
      flag(
        "payload-template",
        'JSON payload template; {input} is the scenario input, e.g. {"prompt":"{input}"}',
        z.string().optional(),
      ),
      flag("header", "an ordered application header (repeatable)", z.array(z.string()).optional()),
      flag(
        "bearer-token",
        "CUSTOM_JWT bearer token (for JWT-auth runtimes)",
        z.string().optional(),
      ),
      flag("user-id", "runtime user id", z.string().optional()),
      flag("dataset", "dataset source: local JSONL path or a dataset id", z.string().optional()),
      flag("dataset-version", "dataset version (with a dataset id)", z.string().optional()),
      flag("evaluator", "evaluator id(s) to apply", z.array(z.string()).optional()),
      flag("name", "batch evaluation name (unique in the account)", z.string().optional()),
      flag("description", "description for the batch evaluation", z.string().optional()),
      flag("kms-key-arn", "KMS key to encrypt evaluation data at rest", z.string().optional()),
      flag(
        "ingestion-wait-ms",
        "ms to wait for span ingestion before grading (default 180000; 0 to skip)",
        z.coerce.number().int().nonnegative().optional(),
      ),
    ],
    handle: async (ctx, flags) => {
      if (!flags["runtime-id"])
        throw new InputValidationError("required option '--runtime-id' not specified");
      if (!flags["payload-template"]) {
        throw new InputValidationError("required option '--payload-template' not specified");
      }
      if (!flags["dataset"])
        throw new InputValidationError("required option '--dataset' not specified");
      if (!flags["evaluator"]?.length) {
        throw new InputValidationError(
          "required option '--evaluator <evaluator...>' not specified",
        );
      }
      if (!flags["name"])
        throw new InputValidationError("required option '--name <name>' not specified");

      // Ctrl-C aborts the run (invokes, the ingestion wait, the dataset download).
      // TODO(#1986): swap for the shared SIGINT/abort helper once it merges.
      const controller = new AbortController();
      const interrupt = () => controller.abort();
      process.once("SIGINT", interrupt);
      try {
        const opts = coreOptsFromCtx(ctx);

        const r = await core.eval.invokeDataset(
          {
            runtimeId: flags["runtime-id"],
            qualifier: flags["qualifier"],
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
            evaluatorIds: flags["evaluator"],
            source: {
              origin: "agent",
              agent: flags["runtime-id"],
              endpoint: flags["qualifier"],
              sessionIds: r.sessions.map((s) => s.sessionId),
            },
            groundTruth: r.sessions.map((s) => ({
              sessionId: s.sessionId,
              testScenarioId: s.exampleId,
              ...(s.groundTruth && { groundTruth: { inline: s.groundTruth } }),
            })),
            kmsKeyArn: flags["kms-key-arn"],
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
