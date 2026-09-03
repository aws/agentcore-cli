import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";
import { JsonDetail } from "../../../../components/JsonDetail";
import { ResourceDetailScreen } from "../../../../components/ResourceDetailScreen";
import type { ScreenProps } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

function useOnlineInsightDetail({ ctx, core }: ScreenProps, configId: string | undefined) {
  const opts = coreOptsFromCtx(ctx);
  return useQuery({
    queryKey: ["online-insight", opts.region, configId],
    queryFn: () => core.eval.getOnlineInsight(configId!, opts),
    enabled: configId !== undefined,
  });
}

export function OnlineInsightGetScreen(props: ScreenProps) {
  const navigate = useNavigate();
  const { configId } = useParams();
  const detail = useOnlineInsightDetail(props, configId);
  const config = detail.data;
  const samplingPercentage = config?.rule?.samplingConfig?.samplingPercentage;
  const insightCount = config?.insights?.length ?? 0;
  const frequencies = config?.clusteringConfig?.frequencies ?? [];

  return (
    <ResourceDetailScreen
      breadcrumb={["agentcore", "eval", "online-insight", "get", configId ?? ""]}
      isPending={detail.isPending}
      error={detail.isError ? (detail.error as Error) : null}
      items={{
        id: config?.onlineEvaluationConfigId ?? "",
        name: config?.onlineEvaluationConfigName ?? "",
        status: config?.status ?? "-",
        execution: config?.executionStatus ?? "-",
        sampling: samplingPercentage !== undefined ? `${samplingPercentage}%` : "-",
        insights: insightCount > 0 ? insightCount.toString() : "-",
        clustering: frequencies.length > 0 ? frequencies.join(", ") : "-",
        ...(config?.failureReason ? { failureReason: config.failureReason } : {}),
        role: config?.evaluationExecutionRoleArn ?? "-",
      }}
      actions={
        configId && config
          ? [
              {
                name: "detail",
                description: "show the full JSON (insights, clustering, filters, data source)",
                onSelect: () =>
                  navigate(
                    `/agentcore/eval/online-insight/get/${encodeURIComponent(configId)}/json`,
                  ),
              },
            ]
          : []
      }
      loadingLabel="Loading online insight config…"
      onRetry={() => void detail.refetch()}
      selectLabel="open"
    />
  );
}

export function OnlineInsightGetJsonScreen(props: ScreenProps) {
  const { configId } = useParams();
  const detail = useOnlineInsightDetail(props, configId);

  return (
    <JsonDetail
      breadcrumb={["agentcore", "eval", "online-insight", "get", configId ?? "", "json"]}
      isPending={detail.isPending}
      error={detail.isError ? (detail.error as Error) : null}
      data={detail.data}
      loadingLabel="Loading online insight config…"
      onRetry={() => void detail.refetch()}
    />
  );
}
