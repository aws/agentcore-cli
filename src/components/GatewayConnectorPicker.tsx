import type { TargetSummary } from "@aws-sdk/client-bedrock-agentcore-control";
import { useNavigate } from "react-router";
import type { ScreenProps } from "../handlers/types";
import { useCoreOpts } from "../handlers/utils";
import { formatTimestamp } from "./formatTimestamp";
import { PaginatedTablePicker } from "./PaginatedTablePicker";
import type { DataTableColumn } from "./ui/data-table";

interface GatewayConnectorRow extends Record<string, unknown> {
  targetId: string;
  name: string;
  status: string;
  updatedAt: string;
}

export const gatewayConnectorColumns = [
  { key: "name", header: "name", flex: true },
  { key: "status", header: "status", width: 18 },
  {
    key: "updatedAt",
    header: "updated UTC",
    width: 16,
    render: formatTimestamp,
  },
] satisfies DataTableColumn<GatewayConnectorRow>[];

function toRow(target: TargetSummary): GatewayConnectorRow {
  return {
    targetId: target.targetId ?? "",
    name: target.name ?? target.targetId ?? "",
    status: target.status ?? "-",
    updatedAt: target.updatedAt?.toISOString() ?? "-",
  };
}

export interface GatewayConnectorPickerProps extends ScreenProps {
  gatewayId: string;
  breadcrumb: string[];
  description?: string;
  onSelect: (targetId: string) => void;
}

export function GatewayConnectorPicker({
  ctx,
  core,
  gatewayId,
  breadcrumb,
  description,
  onSelect,
}: GatewayConnectorPickerProps) {
  const opts = useCoreOpts(ctx);
  const navigate = useNavigate();

  return (
    <PaginatedTablePicker
      breadcrumb={breadcrumb}
      description={description}
      queryKey={["gateway-connectors", opts.region, gatewayId]}
      loadPage={async (token, pageSize) => {
        const response = await core.gateway.listGatewayConnectors(gatewayId, token, pageSize, opts);
        return {
          items: response.items ?? [],
          nextToken: response.nextToken,
        };
      }}
      toRow={toRow}
      columns={gatewayConnectorColumns}
      getValue={(row) => row.targetId}
      onSelect={onSelect}
      onBack={() => navigate(-1)}
      loadingMessage={`loading Connectors for Gateway ${gatewayId}…`}
      errorMessage={(error) =>
        `Error loading Connectors for Gateway ${gatewayId}: ${error.message}`
      }
      emptyMessage="This Gateway has no connectors."
      emptyPageMessage="No Connectors on this page."
    />
  );
}
