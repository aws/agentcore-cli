import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";
import { JsonDetail } from "../../../components/JsonDetail";
import { ResourceDetailScreen } from "../../../components/ResourceDetailScreen";
import type { ScreenProps } from "../../types";
import { useCoreOpts } from "../../utils";

const ACTIONS = [
  {
    name: "invoke",
    description: "invoke this Runtime",
    to: (id: string) => `/agentcore/runtime/invoke/${encodeURIComponent(id)}`,
    returnsToDetails: true,
  },
  {
    name: "shell",
    description: "open an interactive terminal",
    to: (id: string) => `/agentcore/runtime/shell/${encodeURIComponent(id)}`,
    returnsToDetails: true,
  },
  {
    name: "endpoints",
    description: "list this Runtime's endpoints",
    to: (id: string) => `/agentcore/runtime/endpoint/list/${encodeURIComponent(id)}`,
  },
  {
    name: "versions",
    description: "list immutable Runtime versions",
    to: (id: string) => `/agentcore/runtime/version/list/${encodeURIComponent(id)}`,
  },
  {
    name: "detail",
    description: "show the full JSON definition",
    to: (id: string) => `/agentcore/runtime/get/${encodeURIComponent(id)}/json`,
  },
] as const;

function useRuntimeDetail({ ctx, core }: ScreenProps, runtimeId: string | undefined) {
  const opts = useCoreOpts(ctx);
  return useQuery({
    queryKey: ["runtime", opts.region, runtimeId],
    queryFn: () => core.runtime.getRuntime(runtimeId!, opts),
    enabled: runtimeId !== undefined,
  });
}

export function RuntimeGetScreen(props: ScreenProps) {
  const navigate = useNavigate();
  const { runtimeId } = useParams();
  const detail = useRuntimeDetail(props, runtimeId);

  return (
    <ResourceDetailScreen
      breadcrumb={["agentcore", "runtime", "get", runtimeId ?? ""]}
      isPending={detail.isPending}
      error={detail.isError ? (detail.error as Error) : null}
      items={{
        id: detail.data?.agentRuntimeId ?? "",
        status: detail.data?.status ?? "",
        ...(detail.data?.failureReason ? { failureReason: detail.data.failureReason } : {}),
        version: detail.data?.agentRuntimeVersion ?? "",
        protocol: detail.data?.protocolConfiguration?.serverProtocol ?? "-",
        network: detail.data?.networkConfiguration?.networkMode ?? "-",
        arn: detail.data?.agentRuntimeArn ?? "",
      }}
      actions={
        runtimeId && detail.data
          ? ACTIONS.map((action) => ({
              name: action.name,
              description: action.description,
              onSelect: () =>
                navigate(action.to(runtimeId), {
                  state:
                    "returnsToDetails" in action && action.returnsToDetails
                      ? { returnOnEscape: true }
                      : undefined,
                }),
            }))
          : []
      }
      loadingLabel="loading Runtime…"
      onRetry={() => void detail.refetch()}
    />
  );
}

export function RuntimeGetJsonScreen(props: ScreenProps) {
  const { runtimeId } = useParams();
  const detail = useRuntimeDetail(props, runtimeId);

  return (
    <JsonDetail
      breadcrumb={["agentcore", "runtime", "get", runtimeId ?? "", "json"]}
      isPending={detail.isPending}
      error={detail.isError ? (detail.error as Error) : null}
      data={detail.data}
      loadingLabel="loading Runtime…"
      onRetry={() => void detail.refetch()}
    />
  );
}
