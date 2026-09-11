import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import { JsonDetail } from "../../../../components/JsonDetail";
import type { ScreenProps } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

function useRecommendationDetail({ ctx, core }: ScreenProps, id: string | undefined) {
  const opts = coreOptsFromCtx(ctx);
  return useQuery({
    queryKey: ["recommendation", opts.region, id],
    queryFn: () => core.eval.getRecommendation(id!, opts),
    enabled: id !== undefined,
  });
}

// Recommendation get is raw JSON only — no metadata hub, matching batch-evaluation.
// The full response is the value; a curated field subset would just hide data.
export function RecommendationGetJsonScreen(props: ScreenProps) {
  const { recommendationId } = useParams();
  const query = useRecommendationDetail(props, recommendationId);

  return (
    <JsonDetail
      breadcrumb={["agentcore", "eval", "recommendation", "get", recommendationId ?? ""]}
      isPending={query.isPending}
      error={query.isError ? (query.error as Error) : null}
      data={query.data}
      loadingLabel="loading recommendation…"
      onRetry={() => void query.refetch()}
    />
  );
}
