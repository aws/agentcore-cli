import z from "zod";
import { createHandler, flag } from "../../../../router";
import { InputValidationError } from "../../../../errors";
import { JsonRendererKey } from "../../../../tui";
import { warn, type AppIO } from "../../../../io";
import type { Core } from "../../../types";
import type { CoreOptions } from "../../../../core/types";
import type { BatchEvaluationDetail } from "../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createGetBatchEvaluationHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "get",
    description: "get a batch evaluation by id, with CloudWatch-backed results when available",
    flags: [
      flag("id", "the ID of the batch evaluation", z.string().optional()),
      flag(
        "disable-cw-results",
        "skip CloudWatch result retrieval and return only service-side job metadata",
        z.boolean().optional(),
      ),
    ],
    handle: async (ctx, flags) => {
      const id = flags["id"];
      if (!id) throw new InputValidationError("required option '--id <id>' not specified");
      const opts = coreOptsFromCtx(ctx);

      // Core fetches the job and (unless --disable-cw-results) merges the
      // per-session CloudWatch results. A CloudWatch read failure comes back as
      // `resultsError` rather than throwing, so the job status is never hidden;
      // surface it as a stderr warning and still print the metadata.
      const { detail, resultsError } = await core.eval.getBatchEvaluation(id, opts, {
        includeResults: !flags["disable-cw-results"],
      });
      if (resultsError) warnCloudWatchFailure(io, detail, opts, resultsError);

      ctx.require(JsonRendererKey).renderJson(detail);
    },
  });

// warnCloudWatchFailure emits a non-fatal advisory (to stderr, via io.warn) with a
// link to the CloudWatch results, so the machine-readable job status on stdout
// stays clean.
function warnCloudWatchFailure(
  io: AppIO,
  detail: BatchEvaluationDetail,
  opts: CoreOptions,
  error: unknown,
): void {
  const cw = detail.outputConfig?.cloudWatchConfig;
  const link =
    cw?.logGroupName && cw.logStreamName
      ? ` See CloudWatch: region ${opts.region}, log group ${cw.logGroupName}, stream ${cw.logStreamName}.`
      : "";
  warn(
    io,
    `could not retrieve CloudWatch results (${(error as Error).message}). ` +
      `Job status is unaffected.${link}`,
  );
}

export { BatchEvaluationGetJsonScreen } from "./screen.tsx";
