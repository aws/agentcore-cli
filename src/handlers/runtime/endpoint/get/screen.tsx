import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import { JsonDetail } from "../../../../components/JsonDetail";
import { ResourceDetailScreen } from "../../../../components/ResourceDetailScreen";
import type { ScreenProps } from "../../../types";
import { useCoreOpts, useRegionNavigate } from "../../../utils";

function useRuntimeEndpointDetail(
  { ctx, core }: ScreenProps,
  runtimeId: string | undefined,
  qualifier: string | undefined,
) {
  const opts = useCoreOpts(ctx);
  return useQuery({
    queryKey: ["runtime-endpoint", opts.region, runtimeId, qualifier],
    queryFn: () => core.runtime.getRuntimeEndpoint(runtimeId!, qualifier!, opts),
    enabled: runtimeId !== undefined && qualifier !== undefined,
  });
}

function endpointPath(runtimeId: string, qualifier: string, suffix?: string): string {
  const path = `/agentcore/runtime/endpoint/get/${encodeURIComponent(runtimeId)}/${encodeURIComponent(qualifier)}`;
  return suffix ? `${path}/${suffix}` : path;
}

export function RuntimeGetEndpointScreen(props: ScreenProps) {
  const navigate = useRegionNavigate();
  const { runtimeId, qualifier } = useParams();
  const detail = useRuntimeEndpointDetail(props, runtimeId, qualifier);
  const endpoint = detail.data;

  return (
    <ResourceDetailScreen
      breadcrumb={["agentcore", "runtime", "endpoint", "get", runtimeId ?? "", qualifier ?? ""]}
      isPending={detail.isPending}
      error={detail.isError ? (detail.error as Error) : null}
      items={{
        qualifier: endpoint?.name ?? qualifier ?? "",
        status: endpoint?.status ?? "",
        ...(endpoint?.failureReason ? { failureReason: endpoint.failureReason } : {}),
        liveVersion: endpoint?.liveVersion ?? "-",
        targetVersion: endpoint?.targetVersion ?? "-",
        description: endpoint?.description ?? "-",
        updatedAt: endpoint?.lastUpdatedAt?.toISOString() ?? "-",
        arn: endpoint?.agentRuntimeEndpointArn ?? "",
      }}
      actions={
        runtimeId && qualifier && endpoint
          ? [
              {
                name: "invoke",
                description: "invoke this Runtime endpoint",
                onSelect: () =>
                  navigate(
                    `/agentcore/runtime/invoke/${encodeURIComponent(runtimeId)}/${encodeURIComponent(qualifier)}`,
                    { state: { returnOnEscape: true } },
                  ),
              },
              {
                name: "detail",
                description: "show the full JSON definition",
                onSelect: () => navigate(endpointPath(runtimeId, qualifier, "json")),
              },
            ]
          : []
      }
      loadingLabel={`loading endpoint ${qualifier ?? ""} for Runtime ${runtimeId ?? ""}…`}
      onRetry={() => void detail.refetch()}
    />
  );
}

export function RuntimeGetEndpointJsonScreen(props: ScreenProps) {
  const { runtimeId, qualifier } = useParams();
  const detail = useRuntimeEndpointDetail(props, runtimeId, qualifier);

  return (
    <JsonDetail
      breadcrumb={[
        "agentcore",
        "runtime",
        "endpoint",
        "get",
        runtimeId ?? "",
        qualifier ?? "",
        "json",
      ]}
      isPending={detail.isPending}
      error={detail.isError ? (detail.error as Error) : null}
      data={detail.data}
      loadingLabel={`loading endpoint ${qualifier ?? ""} for Runtime ${runtimeId ?? ""}…`}
      onRetry={() => void detail.refetch()}
    />
  );
}
