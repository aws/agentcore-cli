import type { GatewayRuleDetail } from "@aws-sdk/client-bedrock-agentcore-control";
import { useNavigate, useParams } from "react-router";
import { GatewayPicker } from "../../../../components/GatewayPicker";
import { PaginatedTablePicker } from "../../../../components/PaginatedTablePicker";
import type { DataTableColumn } from "../../../../components/ui/data-table";
import type { ScreenProps } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

interface RuleRow extends Record<string, unknown> {
  ruleId: string;
  priority: string;
  status: string;
  description: string;
}

const ruleColumns = [
  { key: "priority", header: "priority", width: 10 },
  { key: "status", header: "status", width: 13 },
  { key: "description", header: "description", flex: true },
  {
    key: "ruleId",
    header: "id suffix",
    width: 10,
    render: (value: unknown) => String(value ?? "").slice(-8),
  },
] satisfies DataTableColumn<RuleRow>[];

function toRow(rule: GatewayRuleDetail): RuleRow {
  return {
    ruleId: rule.ruleId ?? "",
    priority: rule.priority?.toString() ?? "-",
    status: rule.status ?? "-",
    description: rule.description ?? "-",
  };
}

export function GatewayRuleListScreen({ ctx, core }: ScreenProps) {
  const { gatewayId } = useParams();
  const opts = coreOptsFromCtx(ctx);
  const navigate = useNavigate();

  if (!gatewayId) {
    return (
      <GatewayPicker
        ctx={ctx}
        core={core}
        breadcrumb={["agentcore", "gateway", "rule", "list"]}
        description="choose a Gateway to list Rules for"
        onSelect={(id) => navigate(`/agentcore/gateway/rule/list/${encodeURIComponent(id)}`)}
      />
    );
  }

  return (
    <PaginatedTablePicker
      breadcrumb={["agentcore", "gateway", "rule", "list", gatewayId]}
      queryKey={["gateway-rules", opts.region, gatewayId]}
      loadPage={async (token, pageSize) => {
        const response = await core.gateway.listGatewayRules(gatewayId!, token, pageSize, opts);
        return {
          items: response.gatewayRules ?? [],
          nextToken: response.nextToken,
        };
      }}
      toRow={toRow}
      columns={ruleColumns}
      getValue={(row) => row.ruleId}
      onSelect={(ruleId) =>
        navigate(
          `/agentcore/gateway/rule/get/${encodeURIComponent(gatewayId)}/${encodeURIComponent(ruleId)}`,
        )
      }
      onBack={() => navigate(-1)}
      loadingMessage={`Loading Rules for Gateway ${gatewayId}…`}
      errorMessage={(error) => `Error loading Rules for Gateway ${gatewayId}: ${error.message}`}
      emptyMessage="This Gateway has no Rules."
      emptyPageMessage={`No Rules on this page for Gateway ${gatewayId}.`}
    />
  );
}
