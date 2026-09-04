import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import { JsonDetail } from "../../../../components/JsonDetail";
import type { ScreenProps } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export function GatewayTargetGetScreen(props: ScreenProps) {
  const { gatewayId, targetId } = useParams();
  const opts = coreOptsFromCtx(props.ctx);
  const detail = useQuery({
    queryKey: ["gateway-target", opts.region, gatewayId, targetId],
    queryFn: () => props.core.gateway.getGatewayTarget(gatewayId!, targetId!, opts),
    enabled: gatewayId !== undefined && targetId !== undefined,
  });

  return (
    <JsonDetail
      breadcrumb={["agentcore", "gateway", "target", "get", gatewayId ?? "", targetId ?? ""]}
      isPending={detail.isPending}
      error={detail.isError ? (detail.error as Error) : null}
      data={detail.data}
      loadingLabel="loading Gateway Target…"
      onRetry={() => void detail.refetch()}
    />
  );
}
