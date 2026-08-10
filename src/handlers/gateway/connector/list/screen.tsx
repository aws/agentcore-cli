import { TargetType, type TargetSummary } from "@aws-sdk/client-bedrock-agentcore-control";
import { useNavigate, useParams } from "react-router";
import { formatTimestamp } from "../../../../components/formatTimestamp";
import { GatewayPicker } from "../../../../components/GatewayPicker";
import { PaginatedTablePicker } from "../../../../components/PaginatedTablePicker";
import type { DataTableColumn } from "../../../../components/ui/data-table";
import type { ScreenProps } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

interface ConnectorRow extends Record<string, unknown> {
  targetId: string;
  name: string;
  status: string;
  updatedAt: string;
}

const connectorColumns = [
  { key: "name", header: "name", flex: true },
  { key: "status", header: "status", width: 18 },
  {
    key: "updatedAt",
    header: "updated UTC",
    width: 16,
    render: formatTimestamp,
  },
] satisfies DataTableColumn<ConnectorRow>[];

function toConnectorRow(target: TargetSummary): ConnectorRow {
  return {
    targetId: target.targetId ?? "",
    name: target.name ?? target.targetId ?? "",
    status: target.status ?? "-",
    updatedAt: target.updatedAt?.toISOString() ?? "-",
  };
}

export function GatewayConnectorListScreen({ ctx, core }: ScreenProps) {
  const { gatewayId } = useParams();
  const opts = coreOptsFromCtx(ctx);
  const navigate = useNavigate();

  if (!gatewayId) {
    return (
      <GatewayPicker
        ctx={ctx}
        core={core}
        breadcrumb={["agentcore", "gateway", "connector", "list"]}
        description="choose a Gateway to list Connectors for"
        onSelect={(id) => navigate(`/agentcore/gateway/connector/list/${encodeURIComponent(id)}`)}
      />
    );
  }

  return (
    <PaginatedTablePicker
      breadcrumb={["agentcore", "gateway", "connector", "list", gatewayId]}
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
      toRow={toConnectorRow}
      columns={connectorColumns}
      getValue={(row) => row.targetId}
      onSelect={(targetId) =>
        navigate(
          `/agentcore/gateway/connector/get/${encodeURIComponent(gatewayId)}/${encodeURIComponent(targetId)}`,
        )
      }
      onBack={() => navigate(-1)}
      loadingMessage={`Loading Connectors for Gateway ${gatewayId}…`}
      errorMessage={(error) =>
        `Error loading Connectors for Gateway ${gatewayId}: ${error.message}`
      }
      emptyMessage="This Gateway has no Connectors."
      emptyPageMessage="No Connectors on this page."
    />
  );
}
