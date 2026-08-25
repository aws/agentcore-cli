import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import { JsonDetail } from "../../../../components/JsonDetail";
import type { ScreenProps } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

function useBatchInsightsDetail({ ctx, core }: ScreenProps, id: string | undefined) {
  const opts = coreOptsFromCtx(ctx);
  return useQuery({
    queryKey: ["batch-insights", opts.region, id],
    queryFn: () => core.eval.getBatchInsights(id!, opts),
    enabled: id !== undefined,
  });
}

export function BatchInsightsGetJsonScreen(props: ScreenProps) {
  const { batchEvaluationId } = useParams();
  const query = useBatchInsightsDetail(props, batchEvaluationId);

  return (
    <JsonDetail
      breadcrumb={["agentcore", "eval", "batch-insights", "get", batchEvaluationId ?? ""]}
      isPending={query.isPending}
      error={query.isError ? (query.error as Error) : null}
      data={query.data}
      loadingLabel="Loading batch insights…"
      onRetry={() => void query.refetch()}
    />
  );
}
