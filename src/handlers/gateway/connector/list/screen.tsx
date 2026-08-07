import { TargetType } from "@aws-sdk/client-bedrock-agentcore-control";
import { useNavigate, useParams } from "react-router";
import { PaginatedTablePicker } from "../../../../components/PaginatedTablePicker";
import type { ScreenProps } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";
import { targetColumns, targetRow } from "../../target/list/screen";

export function GatewayConnectorListScreen({ ctx, core }: ScreenProps) {
  const { gatewayId } = useParams();
  const opts = coreOptsFromCtx(ctx);
  const navigate = useNavigate();
  const encodedGatewayId = encodeURIComponent(gatewayId ?? "");

  return (
    <PaginatedTablePicker
      breadcrumb={["agentcore", "gateway", gatewayId ?? "", "connectors"]}
      queryKey={["gateway-connectors", opts.region, gatewayId]}
      loadPage={async (token, pageSize) => {
        const response = await core.gateway.listGatewayTargets(gatewayId!, token, pageSize, opts);
        return {
          items: (response.items ?? []).filter(
            (target) => target.targetType === TargetType.CONNECTOR,
          ),
          nextToken: response.nextToken,
        };
      }}
      toRow={targetRow}
      columns={targetColumns}
      getValue={(row) => row.targetId}
      onSelect={(targetId) =>
        navigate(
          `/agentcore/gateway/browse/${encodedGatewayId}/connectors/${encodeURIComponent(targetId)}`,
        )
      }
      onBack={() => navigate(`/agentcore/gateway/browse/${encodedGatewayId}`)}
      loadingMessage="Loading Gateway Connectors…"
      errorMessage={(error) => `Error: ${error.message}`}
      emptyMessage="This Gateway has no Connectors."
      emptyPageMessage="No Connectors on this page."
    />
  );
}
