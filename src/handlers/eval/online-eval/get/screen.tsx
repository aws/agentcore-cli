import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";
import { JsonDetail } from "../../../../components/JsonDetail";
import { ResourceDetailScreen } from "../../../../components/ResourceDetailScreen";
import type { ScreenProps } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

function useOnlineEvalDetail({ ctx, core }: ScreenProps, configId: string | undefined) {
  const opts = coreOptsFromCtx(ctx);
  return useQuery({
    queryKey: ["online-eval", opts.region, configId],
    queryFn: () => core.eval.getOnlineEvaluationConfig(configId!, opts),
    enabled: configId !== undefined,
  });
}

export function OnlineEvalGetScreen(props: ScreenProps) {
  const navigate = useNavigate();
  const { configId } = useParams();
  const detail = useOnlineEvalDetail(props, configId);
  const config = detail.data;
  const samplingPercentage = config?.rule?.samplingConfig?.samplingPercentage;

  return (
    <ResourceDetailScreen
      breadcrumb={["agentcore", "eval", "online-eval", "get", configId ?? ""]}
      isPending={detail.isPending}
      error={detail.isError ? (detail.error as Error) : null}
      items={{
        id: config?.onlineEvaluationConfigId ?? "",
        name: config?.onlineEvaluationConfigName ?? "",
        status: config?.status ?? "-",
        execution: config?.executionStatus ?? "-",
        sampling: samplingPercentage !== undefined ? `${samplingPercentage}%` : "-",
        evaluators: config?.evaluators?.length.toString() ?? "0",
        ...(config?.failureReason ? { failureReason: config.failureReason } : {}),
        role: config?.evaluationExecutionRoleArn ?? "-",
      }}
      actions={
        configId && config
          ? [
              {
                name: "detail",
                description: "show the full JSON (evaluators, filters, data source)",
                onSelect: () =>
                  navigate(`/agentcore/eval/online-eval/get/${encodeURIComponent(configId)}/json`),
              },
            ]
          : []
      }
      loadingLabel="loading online evaluation config…"
      onRetry={() => void detail.refetch()}
      selectLabel="open"
    />
  );
}

export function OnlineEvalGetJsonScreen(props: ScreenProps) {
  const { configId } = useParams();
  const detail = useOnlineEvalDetail(props, configId);

  return (
    <JsonDetail
      breadcrumb={["agentcore", "eval", "online-eval", "get", configId ?? "", "json"]}
      isPending={detail.isPending}
      error={detail.isError ? (detail.error as Error) : null}
      data={detail.data}
      loadingLabel="loading online evaluation config…"
      onRetry={() => void detail.refetch()}
    />
  );
}
