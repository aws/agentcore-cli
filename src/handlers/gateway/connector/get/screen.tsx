import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import { JsonDetail } from "../../../../components/JsonDetail";
import type { ScreenProps } from "../../../types";
import { useCoreOpts } from "../../../utils";

export function GatewayConnectorGetScreen(props: ScreenProps) {
  const { gatewayId, targetId } = useParams();
  const opts = useCoreOpts(props.ctx);
  const detail = useQuery({
    queryKey: ["gateway-connector", opts.region, gatewayId, targetId],
    queryFn: () => props.core.gateway.getGatewayConnector(gatewayId!, targetId!, opts),
    enabled: gatewayId !== undefined && targetId !== undefined,
  });

  return (
    <JsonDetail
      breadcrumb={["agentcore", "gateway", "connector", "get", gatewayId ?? "", targetId ?? ""]}
      isPending={detail.isPending}
      error={detail.isError ? (detail.error as Error) : null}
      data={detail.data}
      loadingLabel="loading Gateway connector…"
      onRetry={() => void detail.refetch()}
    />
  );
}
