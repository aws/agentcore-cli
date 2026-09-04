import type { GatewayRuleDetail } from "@aws-sdk/client-bedrock-agentcore-control";
import { useNavigate } from "react-router";
import type { ScreenProps } from "../handlers/types";
import { useCoreOpts } from "../handlers/utils";
import { PaginatedTablePicker } from "./PaginatedTablePicker";
import type { DataTableColumn } from "./ui/data-table";

interface GatewayRuleRow extends Record<string, unknown> {
  ruleId: string;
  priority: string;
  status: string;
  description: string;
}

export const gatewayRuleColumns = [
  { key: "priority", header: "priority", width: 10 },
  { key: "status", header: "status", width: 13 },
  { key: "description", header: "description", flex: true },
  {
    key: "ruleId",
    header: "ID suffix",
    width: 10,
    render: (value: unknown) => String(value ?? "").slice(-8),
  },
] satisfies DataTableColumn<GatewayRuleRow>[];

function toRow(rule: GatewayRuleDetail): GatewayRuleRow {
  return {
    ruleId: rule.ruleId ?? "",
    priority: rule.priority?.toString() ?? "-",
    status: rule.status ?? "-",
    description: rule.description ?? "-",
  };
}

export interface GatewayRulePickerProps extends ScreenProps {
  gatewayId: string;
  breadcrumb: string[];
  description?: string;
  onSelect: (ruleId: string) => void;
}

export function GatewayRulePicker({
  ctx,
  core,
  gatewayId,
  breadcrumb,
  description,
  onSelect,
}: GatewayRulePickerProps) {
  const opts = useCoreOpts(ctx);
  const navigate = useNavigate();

  return (
    <PaginatedTablePicker
      breadcrumb={breadcrumb}
      description={description}
      queryKey={["gateway-rules", opts.region, gatewayId]}
      loadPage={async (token, pageSize) => {
        const response = await core.gateway.listGatewayRules(gatewayId, token, pageSize, opts);
        return {
          items: response.gatewayRules ?? [],
          nextToken: response.nextToken,
        };
      }}
      toRow={toRow}
      columns={gatewayRuleColumns}
      getValue={(row) => row.ruleId}
      onSelect={onSelect}
      onBack={() => navigate(-1)}
      loadingMessage={`loading Rules for Gateway ${gatewayId}…`}
      errorMessage={(error) => `Error loading Rules for Gateway ${gatewayId}: ${error.message}`}
      emptyMessage="This Gateway has no Rules."
      emptyPageMessage={`No Rules on this page for Gateway ${gatewayId}.`}
    />
  );
}
