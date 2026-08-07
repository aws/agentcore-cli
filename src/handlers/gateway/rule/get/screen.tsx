import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import { JsonDetail } from "../../../../components/JsonDetail";
import type { ScreenProps } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export function GatewayRuleJsonScreen(props: ScreenProps) {
  const { gatewayId, ruleId } = useParams();
  const opts = coreOptsFromCtx(props.ctx);
  const detail = useQuery({
    queryKey: ["gateway-rule", opts.region, gatewayId, ruleId],
    queryFn: () => props.core.gateway.getGatewayRule(gatewayId!, ruleId!, opts),
    enabled: gatewayId !== undefined && ruleId !== undefined,
  });

  return (
    <JsonDetail
      breadcrumb={["agentcore", "gateway", gatewayId ?? "", "rules", ruleId ?? ""]}
      isPending={detail.isPending}
      error={detail.isError ? (detail.error as Error) : null}
      data={detail.data}
      loadingLabel="Loading Gateway Rule…"
      onRetry={() => void detail.refetch()}
    />
  );
}
