import z from "zod";
import { createHandler, flag } from "../../../../router";
import { InputValidationError } from "../../../../errors";
import { JsonRendererKey } from "../../../../tui";
import type { AppIO } from "../../../../io";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";
import { parseRuntimeInvokeHeaders } from "../../../runtime/invoke/request";

// batch-evaluation simulate replays a dataset against a runtime (invoke per scenario)
// then submits a batch evaluation over the sessions it created. Invoke flags mirror
// `runtime invoke`; content-type/accept are fixed to application/json.
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
      flag(
        "session-id",
        "runtime session id to reuse (default: fresh per scenario)",
        z.string().optional(),
      ),
      flag("user-id", "runtime user id", z.string().optional()),
      flag("dataset", "dataset source: local JSONL path or a dataset id", z.string().optional()),
      flag("dataset-version", "dataset version (with a dataset id)", z.string().optional()),
      flag("evaluator", "evaluator id(s) to apply", z.array(z.string()).optional()),
      flag("name", "batch evaluation name (unique in the account)", z.string().optional()),
      flag("description", "optional description", z.string().optional()),
      flag("kms-key-arn", "KMS key to encrypt evaluation data at rest", z.string().optional()),
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

      const result = await core.eval.simulate(
        {
          runtimeId: flags["runtime-id"],
          qualifier: flags["qualifier"],
          payloadTemplate: flags["payload-template"],
          headers: parseRuntimeInvokeHeaders(flags["header"]),
          bearerToken: flags["bearer-token"],
          sessionId: flags["session-id"],
          userId: flags["user-id"],
          dataset: flags["dataset"],
          datasetVersion: flags["dataset-version"],
          evaluatorIds: flags["evaluator"],
          name: flags["name"],
          description: flags["description"],
          kmsKeyArn: flags["kms-key-arn"],
        },
        coreOptsFromCtx(ctx),
      );
      ctx.require(JsonRendererKey).renderJson(result);
    },
  });
