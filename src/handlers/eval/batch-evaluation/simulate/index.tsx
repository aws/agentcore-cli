import z from "zod";
import { createHandler, flag } from "../../../../router";
import { InputValidationError } from "../../../../errors";
import { JsonRendererKey } from "../../../../tui";
import type { AppIO } from "../../../../io";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";
import { parseRuntimeInvokeHeaders } from "../../../runtime/invoke/request";
import { HELP_GROUP } from "../../helpGroups";

// Composes invokeDataset (replay) → startBatchEvaluation (grade). Invoke flags mirror
// `runtime invoke`.
export const createSimulateBatchEvaluationHandler = (core: Core, _io: AppIO) =>
  createHandler({
    name: "simulate",
    description: "replay a dataset against a Runtime, then batch-evaluate the resulting sessions",
    flags: [
      flag("runtime-id", "Runtime ID to invoke per scenario", z.string().optional(), {
        group: HELP_GROUP.runtimeInvocation,
      }),
      flag("qualifier", "Runtime endpoint qualifier (default DEFAULT)", z.string().optional(), {
        group: HELP_GROUP.runtimeInvocation,
      }),
      flag(
        "payload-template",
        'JSON payload template; {input} is the scenario input, e.g. {"prompt":"{input}"}',
        z.string().optional(),
        { group: HELP_GROUP.runtimeInvocation },
      ),
      flag("header", "an ordered application header (repeatable)", z.array(z.string()).optional(), {
        group: HELP_GROUP.runtimeInvocation,
        sensitive: true,
      }),
      flag(
        "bearer-token",
        "CUSTOM_JWT bearer token (for JWT-auth Runtimes)",
        z.string().optional(),
        { group: HELP_GROUP.runtimeInvocation, sensitive: true },
      ),
      flag("user-id", "Runtime user ID", z.string().optional(), {
        group: HELP_GROUP.runtimeInvocation,
      }),
      flag("dataset", "dataset source: local JSONL path or a dataset ID", z.string().optional(), {
        group: HELP_GROUP.dataset,
      }),
      flag("dataset-version", "dataset version (with a dataset ID)", z.string().optional(), {
        group: HELP_GROUP.dataset,
      }),
      flag(
        "ingestion-wait-ms",
        "ms to wait for span ingestion before grading (default 180000; 0 to skip)",
        z.coerce.number().int().nonnegative().optional(),
        { group: HELP_GROUP.dataset },
      ),
      flag("name", "batch evaluation name (unique in the account)", z.string().optional(), {
        group: HELP_GROUP.configuration,
      }),
      flag("description", "description for the batch evaluation", z.string().optional(), {
        group: HELP_GROUP.configuration,
      }),
      flag("kms-key-arn", "KMS key to encrypt evaluation data at rest", z.string().optional(), {
        group: HELP_GROUP.configuration,
      }),
      flag("evaluators", "evaluator ID(s) to apply", z.array(z.string()).optional(), {
        group: HELP_GROUP.evaluation,
      }),
    ],
    examples: [
      {
        description: "Replay a local JSONL dataset and evaluate the generated sessions",
        command: [
          "agentcore eval batch-evaluation simulate",
          "--runtime-id my-runtime-id",
          `--payload-template '{"prompt":"{input}"}'`,
          "--dataset ./evaluation-dataset.jsonl",
          "--evaluators Builtin.Helpfulness Builtin.Correctness",
          "--name dataset-quality",
        ],
      },
      {
        description: "Use a managed dataset version and a named Runtime endpoint",
        command: [
          "agentcore eval batch-evaluation simulate",
          "--runtime-id my-runtime-id",
          "--qualifier BETA",
          `--payload-template '{"prompt":"{input}"}'`,
          "--dataset dataset-abc123",
          "--dataset-version 2",
          "--evaluators Builtin.Helpfulness",
          "--name dataset-version-2",
        ],
      },
      {
        description: "Invoke a CUSTOM_JWT Runtime",
        command: [
          "agentcore eval batch-evaluation simulate",
          "--runtime-id my-runtime-id",
          `--payload-template '{"prompt":"{input}"}'`,
          "--dataset ./evaluation-dataset.jsonl",
          '--bearer-token "$RUNTIME_TOKEN"',
          "--user-id user-123",
          "--evaluators Builtin.Correctness",
          "--name authenticated-simulation",
        ],
      },
      {
        description: "Pass application headers to every invocation",
        command: [
          "agentcore eval batch-evaluation simulate",
          "--runtime-id my-runtime-id",
          `--payload-template '{"prompt":"{input}"}'`,
          "--dataset ./evaluation-dataset.jsonl",
          '--header "X-Tenant-Id: customer-123" "X-Request-Source: evaluation"',
          "--evaluators Builtin.Helpfulness",
          "--name tenant-evaluation",
        ],
      },
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
            evaluatorIds: flags["evaluators"],
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
