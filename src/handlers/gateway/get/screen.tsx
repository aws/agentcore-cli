import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";
import { JsonDetail } from "../../../components/JsonDetail";
import { ResourceDetailScreen } from "../../../components/ResourceDetailScreen";
import type { ScreenProps } from "../../types";
import { coreOptsFromCtx } from "../../utils";

function useGatewayDetail({ ctx, core }: ScreenProps, gatewayId: string | undefined) {
  const opts = coreOptsFromCtx(ctx);
  return useQuery({
    queryKey: ["gateway", opts.region, gatewayId],
    queryFn: () => core.gateway.getGateway(gatewayId!, opts),
    enabled: gatewayId !== undefined,
  });
}

export function GatewayGetScreen(props: ScreenProps) {
  const navigate = useNavigate();
  const { gatewayId } = useParams();
  const detail = useGatewayDetail(props, gatewayId);

  return (
    <ResourceDetailScreen
      breadcrumb={["agentcore", "gateway", "get", gatewayId ?? ""]}
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
                onSelect: () =>
                  navigate(`/agentcore/gateway/get/${encodeURIComponent(gatewayId)}/json`),
              },
              {
                name: "targets",
                description: "browse every Target",
                onSelect: () =>
                  navigate(`/agentcore/gateway/target/list/${encodeURIComponent(gatewayId)}`),
              },
              {
                name: "connectors",
                description: "browse configured Connectors",
                onSelect: () =>
                  navigate(`/agentcore/gateway/connector/list/${encodeURIComponent(gatewayId)}`),
              },
              {
                name: "rules",
                description: "browse routing Rules",
                onSelect: () =>
                  navigate(`/agentcore/gateway/rule/list/${encodeURIComponent(gatewayId)}`),
              },
            ]
          : []
      }
      loadingLabel="loading Gateway…"
      onRetry={() => void detail.refetch()}
      selectLabel="open"
    />
  );
}

export function GatewayGetJsonScreen(props: ScreenProps) {
  const { gatewayId } = useParams();
  const detail = useGatewayDetail(props, gatewayId);

  return (
    <JsonDetail
      breadcrumb={["agentcore", "gateway", "get", gatewayId ?? "", "json"]}
      isPending={detail.isPending}
      error={detail.isError ? (detail.error as Error) : null}
      data={detail.data}
      loadingLabel="loading Gateway…"
      onRetry={() => void detail.refetch()}
    />
  );
}
