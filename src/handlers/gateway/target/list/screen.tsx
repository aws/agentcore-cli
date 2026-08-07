import type { TargetSummary } from "@aws-sdk/client-bedrock-agentcore-control";
import { useNavigate, useParams } from "react-router";
import { formatTimestamp } from "../../../../components/formatTimestamp";
import { PaginatedTablePicker } from "../../../../components/PaginatedTablePicker";
import type { DataTableColumn } from "../../../../components/ui/data-table";
import type { ScreenProps } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

interface TargetRow extends Record<string, unknown> {
  targetId: string;
  name: string;
  type: string;
  status: string;
  updatedAt: string;
}

export const targetColumns = [
  { key: "name", header: "name", flex: true },
  { key: "type", header: "type", width: 18 },
  { key: "status", header: "status", width: 18 },
  {
    key: "updatedAt",
    header: "updated UTC",
    width: 16,
    render: formatTimestamp,
  },
] satisfies DataTableColumn<TargetRow>[];

export function targetRow(target: TargetSummary): TargetRow {
  return {
    targetId: target.targetId ?? "",
    name: target.name ?? target.targetId ?? "",
    type: target.targetType ?? "-",
    status: target.status ?? "-",
    updatedAt: target.updatedAt?.toISOString() ?? "-",
  };
}

export function GatewayTargetListScreen({ ctx, core }: ScreenProps) {
  const { gatewayId } = useParams();
  const opts = coreOptsFromCtx(ctx);
  const navigate = useNavigate();
  const encodedGatewayId = encodeURIComponent(gatewayId ?? "");

  return (
    <PaginatedTablePicker
      breadcrumb={["agentcore", "gateway", gatewayId ?? "", "targets"]}
      queryKey={["gateway-targets", opts.region, gatewayId]}
      loadPage={async (token, pageSize) => {
        const response = await core.gateway.listGatewayTargets(gatewayId!, token, pageSize, opts);
        return {
          items: response.items ?? [],
          nextToken: response.nextToken,
        };
      }}
      toRow={targetRow}
      columns={targetColumns}
      getValue={(row) => row.targetId}
      onSelect={(targetId) =>
        navigate(
          `/agentcore/gateway/browse/${encodedGatewayId}/targets/${encodeURIComponent(targetId)}`,
        )
      }
      onBack={() => navigate(`/agentcore/gateway/browse/${encodedGatewayId}`)}
      loadingMessage="Loading Gateway Targets…"
      errorMessage={(error) => `Error: ${error.message}`}
      emptyMessage="This Gateway has no Targets."
      emptyPageMessage="No Targets on this page."
    />
  );
}
