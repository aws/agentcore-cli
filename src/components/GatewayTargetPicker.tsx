import type { TargetSummary } from "@aws-sdk/client-bedrock-agentcore-control";
import { useNavigate } from "react-router";
import type { ScreenProps } from "../handlers/types";
import { useCoreOpts } from "../handlers/utils";
import { formatTimestamp } from "./formatTimestamp";
import { PaginatedTablePicker } from "./PaginatedTablePicker";
import type { DataTableColumn } from "./ui/data-table";

interface GatewayTargetRow extends Record<string, unknown> {
  targetId: string;
  name: string;
  type: string;
  status: string;
  updatedAt: string;
}

export const gatewayTargetColumns = [
  { key: "name", header: "name", flex: true },
  { key: "type", header: "type", width: 18 },
  { key: "status", header: "status", width: 18 },
  {
    key: "updatedAt",
    header: "updated UTC",
    width: 16,
    render: formatTimestamp,
  },
] satisfies DataTableColumn<GatewayTargetRow>[];

function toRow(target: TargetSummary): GatewayTargetRow {
  return {
    targetId: target.targetId ?? "",
    name: target.name ?? target.targetId ?? "",
    type: target.targetType ?? "-",
    status: target.status ?? "-",
    updatedAt: target.updatedAt?.toISOString() ?? "-",
  };
}

export interface GatewayTargetPickerProps extends ScreenProps {
  gatewayId: string;
  breadcrumb: string[];
  description?: string;
  onSelect: (targetId: string) => void;
}

export function GatewayTargetPicker({
  ctx,
  core,
  gatewayId,
  breadcrumb,
  description,
  onSelect,
}: GatewayTargetPickerProps) {
  const opts = useCoreOpts(ctx);
  const navigate = useNavigate();

  return (
    <PaginatedTablePicker
      breadcrumb={breadcrumb}
      description={description}
      queryKey={["gateway-targets", opts.region, gatewayId]}
      loadPage={async (token, pageSize) => {
        const response = await core.gateway.listGatewayTargets(gatewayId, token, pageSize, opts);
        return {
          items: response.items ?? [],
          nextToken: response.nextToken,
        };
      }}
      toRow={toRow}
      columns={gatewayTargetColumns}
      getValue={(row) => row.targetId}
      onSelect={onSelect}
      onBack={() => navigate(-1)}
      loadingMessage={`loading Targets for Gateway ${gatewayId}…`}
      errorMessage={(error) => `Error loading Targets for Gateway ${gatewayId}: ${error.message}`}
      emptyMessage="This Gateway has no Targets."
      emptyPageMessage={`No Targets on this page for Gateway ${gatewayId}.`}
    />
  );
}
