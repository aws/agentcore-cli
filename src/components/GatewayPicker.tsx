import type { GatewaySummary } from "@aws-sdk/client-bedrock-agentcore-control";
import { useNavigate } from "react-router";
import type { ScreenProps } from "../handlers/types";
import { coreOptsFromCtx } from "../handlers/utils";
import { formatTimestamp } from "./formatTimestamp";
import { PaginatedTablePicker } from "./PaginatedTablePicker";
import type { DataTableColumn } from "./ui/data-table";

interface GatewayRow extends Record<string, unknown> {
  gatewayId: string;
  name: string;
  status: string;
  protocol: string;
  authorizer: string;
  updatedAt: string;
}

export const gatewayColumns = [
  { key: "name", header: "name", flex: true },
  { key: "status", header: "status", width: 16 },
  { key: "protocol", header: "protocol", width: 12 },
  { key: "authorizer", header: "authorizer", width: 18 },
  {
    key: "updatedAt",
    header: "updated UTC",
    width: 16,
    render: formatTimestamp,
  },
] satisfies DataTableColumn<GatewayRow>[];

function toRow(gateway: GatewaySummary): GatewayRow {
  return {
    gatewayId: gateway.gatewayId ?? "",
    name: gateway.name ?? gateway.gatewayId ?? "",
    status: gateway.status ?? "-",
    protocol: gateway.protocolType ?? "unrestricted",
    authorizer: gateway.authorizerType ?? "-",
    updatedAt: gateway.updatedAt?.toISOString() ?? "-",
  };
}

export interface GatewayPickerProps extends ScreenProps {
  breadcrumb: string[];
  description?: string;
  onSelect: (gatewayId: string) => void;
  onEscape?: () => void;
}

export function GatewayPicker({
  ctx,
  core,
  breadcrumb,
  description,
  onSelect,
  onEscape,
}: GatewayPickerProps) {
  const opts = coreOptsFromCtx(ctx);
  const navigate = useNavigate();

  return (
    <PaginatedTablePicker
      breadcrumb={breadcrumb}
      description={description}
      queryKey={["gateways", opts.region]}
      loadPage={async (token, pageSize) => {
        const response = await core.gateway.listGateways(token, pageSize, opts);
        return {
          items: response.items ?? [],
          nextToken: response.nextToken,
        };
      }}
      toRow={toRow}
      columns={gatewayColumns}
      getValue={(row) => row.gatewayId}
      onSelect={onSelect}
      onBack={onEscape ?? (() => navigate("/" + breadcrumb.slice(0, -1).join("/")))}
      loadingMessage="Loading Gateways…"
      errorMessage={(error) => `Error: ${error.message}`}
      emptyMessage="No Gateways found in this Region."
      emptyPageMessage="No Gateways on this page."
    />
  );
}
