import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import { JsonDetail } from "../../../../components/JsonDetail";
import type { ScreenProps } from "../../../types";
import { useCoreOpts } from "../../../utils";

// getBatchEvaluation already fetches the job and merges the per-session CloudWatch
// results, returning `{ detail, resultsError? }`. The screen keeps both: a
// CloudWatch read failure omits `results` but must stay distinguishable from a job
// that simply has none yet, so `resultsError` drives a warning banner (the TUI's
// equivalent of the CLI's stderr warning).
function useBatchEvaluationDetail({ ctx, core }: ScreenProps, id: string | undefined) {
  const opts = useCoreOpts(ctx);
  return useQuery({
    queryKey: ["batch-evaluation", opts.region, id],
    queryFn: () => core.eval.getBatchEvaluation(id!, opts),
    enabled: id !== undefined,
  });
}

// Batch-evaluation get is raw JSON only — no metadata hub. The value is the full
// response (job metadata + per-session results), which the JSON already shows
// cleanly; a curated field subset would just hide data.
export function BatchEvaluationGetJsonScreen(props: ScreenProps) {
  const { batchEvaluationId } = useParams();
  const query = useBatchEvaluationDetail(props, batchEvaluationId);
  const resultsError = query.data?.resultsError;

  return (
    <JsonDetail
      breadcrumb={["agentcore", "eval", "batch-evaluation", "get", batchEvaluationId ?? ""]}
      isPending={query.isPending}
      error={query.isError ? (query.error as Error) : null}
      data={query.data?.detail}
      warning={
        resultsError
          ? `could not retrieve CloudWatch results (${(resultsError as Error).message}). Job status is unaffected.`
          : undefined
      }
      loadingLabel="loading batch evaluation…"
      onRetry={() => void query.refetch()}
    />
  );
}
