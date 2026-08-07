import type { TargetConfiguration } from "@aws-sdk/client-bedrock-agentcore-control";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import { JsonDetail } from "../../../../components/JsonDetail";
import { InputValidationError } from "../../../../errors";
import type { ScreenProps } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

function isConnectorTarget(configuration: TargetConfiguration | undefined): boolean {
  return (
    configuration?.mcp?.connector !== undefined || configuration?.inference?.connector !== undefined
  );
}

export function GatewayConnectorJsonScreen(props: ScreenProps) {
  const { gatewayId, targetId } = useParams();
  const opts = coreOptsFromCtx(props.ctx);
  const detail = useQuery({
    queryKey: ["gateway-connector", opts.region, gatewayId, targetId],
    queryFn: async () => {
      const target = await props.core.gateway.getGatewayTarget(gatewayId!, targetId!, opts);
      if (!isConnectorTarget(target.targetConfiguration)) {
        throw new InputValidationError(`Gateway Target "${targetId}" is not connector-backed`);
      }
      return target;
    },
    enabled: gatewayId !== undefined && targetId !== undefined,
  });

  return (
    <JsonDetail
      breadcrumb={["agentcore", "gateway", gatewayId ?? "", "connectors", targetId ?? ""]}
      isPending={detail.isPending}
      error={detail.isError ? (detail.error as Error) : null}
      data={detail.data}
      loadingLabel="Loading Gateway Connector…"
      onRetry={() => void detail.refetch()}
    />
  );
}
