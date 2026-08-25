import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";
import { JsonDetail } from "../../../../components/JsonDetail";
import { ResourceDetailScreen } from "../../../../components/ResourceDetailScreen";
import type { ScreenProps } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

function useAbTestDetail({ ctx, core }: ScreenProps, abTestId: string | undefined) {
  const opts = coreOptsFromCtx(ctx);
  return useQuery({
    queryKey: ["ab-test", opts.region, abTestId],
    queryFn: () => core.eval.getABTest(abTestId!, opts),
    enabled: abTestId !== undefined,
  });
}

export function AbTestGetScreen(props: ScreenProps) {
  const navigate = useNavigate();
  const { abTestId } = useParams();
  const detail = useAbTestDetail(props, abTestId);
  const test = detail.data;

  const variants = (test?.variants ?? [])
    .map((variant) => `${variant.name ?? "?"} ${variant.weight ?? 0}%`)
    .join(" / ");

  return (
    <ResourceDetailScreen
      breadcrumb={["agentcore", "eval", "ab-test", "get", abTestId ?? ""]}
      isPending={detail.isPending}
      error={detail.isError ? (detail.error as Error) : null}
      items={{
        id: test?.abTestId ?? "",
        name: test?.name ?? "-",
        status: test?.status ?? "",
        execution: test?.executionStatus ?? "",
        ...(test?.errorDetails?.length ? { errors: test.errorDetails.join("; ") } : {}),
        ...(variants ? { variants } : {}),
        gateway: test?.gatewayArn ?? "-",
        arn: test?.abTestArn ?? "",
      }}
      actions={
        abTestId && test
          ? [
              {
                name: "detail",
                description: "show the full JSON definition, including per-evaluator metrics",
                onSelect: () =>
                  navigate(`/agentcore/eval/ab-test/get/${encodeURIComponent(abTestId)}/json`),
              },
            ]
          : []
      }
      loadingLabel="Loading A/B test…"
      onRetry={() => void detail.refetch()}
    />
  );
}

export function AbTestGetJsonScreen(props: ScreenProps) {
  const { abTestId } = useParams();
  const detail = useAbTestDetail(props, abTestId);

  return (
    <JsonDetail
      breadcrumb={["agentcore", "eval", "ab-test", "get", abTestId ?? "", "json"]}
      isPending={detail.isPending}
      error={detail.isError ? (detail.error as Error) : null}
      data={detail.data}
      loadingLabel="Loading A/B test…"
      onRetry={() => void detail.refetch()}
    />
  );
}
