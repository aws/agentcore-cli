import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";
import { JsonDetail } from "../../../components/JsonDetail";
import { ResourceDetailScreen } from "../../../components/ResourceDetailScreen";
import type { ScreenProps } from "../../types";
import { coreOptsFromCtx } from "../../utils";

function gatewayPath(gatewayId: string): string {
  return `/agentcore/gateway/browse/${encodeURIComponent(gatewayId)}`;
}

function useGatewayDetail({ ctx, core }: ScreenProps, gatewayId: string | undefined) {
  const opts = coreOptsFromCtx(ctx);
  return useQuery({
    queryKey: ["gateway", opts.region, gatewayId],
    queryFn: () => core.gateway.getGateway(gatewayId!, opts),
    enabled: gatewayId !== undefined,
  });
}

export function GatewayDetailScreen(props: ScreenProps) {
  const navigate = useNavigate();
  const { gatewayId } = useParams();
  const detail = useGatewayDetail(props, gatewayId);

  return (
    <ResourceDetailScreen
      breadcrumb={["agentcore", "gateway", gatewayId ?? ""]}
      isPending={detail.isPending}
      error={detail.isError ? (detail.error as Error) : null}
      items={{
        name: detail.data?.name ?? "",
        id: detail.data?.gatewayId ?? gatewayId ?? "",
        status: detail.data?.status ?? "",
        protocol: detail.data?.protocolType ?? "unrestricted",
        authorizer: detail.data?.authorizerType ?? "-",
        url: detail.data?.gatewayUrl ?? "",
      }}
      actions={
        gatewayId && detail.data
          ? [
              {
                name: "detail",
                description: "show the full JSON definition",
                onSelect: () => navigate(`${gatewayPath(gatewayId)}/json`),
              },
              {
                name: "targets",
                description: "browse every Target",
                onSelect: () => navigate(`${gatewayPath(gatewayId)}/targets`),
              },
              {
                name: "connectors",
                description: "browse connector-backed Targets",
                onSelect: () => navigate(`${gatewayPath(gatewayId)}/connectors`),
              },
              {
                name: "rules",
                description: "browse routing Rules",
                onSelect: () => navigate(`${gatewayPath(gatewayId)}/rules`),
              },
            ]
          : []
      }
      loadingLabel="Loading Gateway…"
      onRetry={() => void detail.refetch()}
      selectLabel="open"
    />
  );
}

export function GatewayJsonScreen(props: ScreenProps) {
  const { gatewayId } = useParams();
  const detail = useGatewayDetail(props, gatewayId);

  return (
    <JsonDetail
      breadcrumb={["agentcore", "gateway", gatewayId ?? "", "json"]}
      isPending={detail.isPending}
      error={detail.isError ? (detail.error as Error) : null}
      data={detail.data}
      loadingLabel="Loading Gateway…"
      onRetry={() => void detail.refetch()}
    />
  );
}
