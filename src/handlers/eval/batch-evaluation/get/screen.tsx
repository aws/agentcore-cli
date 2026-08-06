import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import { JsonDetail } from "../../../../components/JsonDetail";
import type { ScreenProps } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

// getBatchEvaluation already fetches the job and merges the per-session CloudWatch
// results, returning `{ detail, resultsError? }`. The screen unwraps `detail`;
// `resultsError` is ignored here — a CloudWatch read failure just omits `results`
// (the CLI is the surface that warns on stderr).
function useBatchEvaluationDetail({ ctx, core }: ScreenProps, id: string | undefined) {
  const opts = coreOptsFromCtx(ctx);
  return useQuery({
    queryKey: ["batch-evaluation", opts.region, id],
    queryFn: async () => (await core.eval.getBatchEvaluation(id!, opts)).detail,
    enabled: id !== undefined,
  });
}

// Batch-evaluation get is raw JSON only — no metadata hub. The value is the full
// response (job metadata + per-session results), which the JSON already shows
// cleanly; a curated field subset would just hide data.
export function BatchEvaluationGetJsonScreen(props: ScreenProps) {
  const { batchEvaluationId } = useParams();
  const detail = useBatchEvaluationDetail(props, batchEvaluationId);

  return (
    <JsonDetail
      breadcrumb={["agentcore", "eval", "batch-evaluation", "get", batchEvaluationId ?? ""]}
      isPending={detail.isPending}
      error={detail.isError ? (detail.error as Error) : null}
      data={detail.data}
      loadingLabel="Loading batch evaluation…"
      onRetry={() => void detail.refetch()}
    />
  );
}
