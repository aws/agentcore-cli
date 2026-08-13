import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";
import { JsonDetail } from "../../../../components/JsonDetail";
import { ResourceDetailScreen } from "../../../../components/ResourceDetailScreen";
import type { ScreenProps } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

function useDatasetDetail({ ctx, core }: ScreenProps, datasetId: string | undefined) {
  const opts = coreOptsFromCtx(ctx);
  return useQuery({
    queryKey: ["dataset", opts.region, datasetId],
    queryFn: () => core.eval.getDataset(datasetId!, undefined, opts),
    enabled: datasetId !== undefined,
  });
}

export function DatasetGetScreen(props: ScreenProps) {
  const navigate = useNavigate();
  const { datasetId } = useParams();
  const detail = useDatasetDetail(props, datasetId);
  const dataset = detail.data;

  return (
    <ResourceDetailScreen
      breadcrumb={["agentcore", "eval", "dataset", "get", datasetId ?? ""]}
      isPending={detail.isPending}
      error={detail.isError ? (detail.error as Error) : null}
      items={{
        id: dataset?.datasetId ?? "",
        name: dataset?.datasetName ?? "",
        version: dataset?.datasetVersion ?? "DRAFT",
        status: dataset?.status ?? "-",
        draftStatus: dataset?.draftStatus ?? "-",
        schema: dataset?.schemaType ?? "-",
        examples: dataset?.exampleCount?.toString() ?? "-",
        ...(dataset?.description ? { description: dataset.description } : {}),
        ...(dataset?.failureReason ? { failureReason: dataset.failureReason } : {}),
        ...(dataset?.kmsKeyArn ? { kmsKeyArn: dataset.kmsKeyArn } : {}),
        arn: dataset?.datasetArn ?? "",
      }}
      actions={
        datasetId && dataset
          ? [
              {
                name: "detail",
                description: "show the full JSON metadata",
                onSelect: () =>
                  navigate(`/agentcore/eval/dataset/get/${encodeURIComponent(datasetId)}/json`),
              },
            ]
          : []
      }
      loadingLabel="Loading dataset…"
      onRetry={() => void detail.refetch()}
      selectLabel="open detail"
    />
  );
}

export function DatasetGetJsonScreen(props: ScreenProps) {
  const { datasetId } = useParams();
  const detail = useDatasetDetail(props, datasetId);

  return (
    <JsonDetail
      breadcrumb={["agentcore", "eval", "dataset", "get", datasetId ?? "", "json"]}
      isPending={detail.isPending}
      error={detail.isError ? (detail.error as Error) : null}
      data={detail.data}
      loadingLabel="Loading dataset…"
      onRetry={() => void detail.refetch()}
    />
  );
}
