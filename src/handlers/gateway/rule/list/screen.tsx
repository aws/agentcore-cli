import { useNavigate, useParams } from "react-router";
import { GatewayPicker } from "../../../../components/GatewayPicker";
import { GatewayRulePicker } from "../../../../components/GatewayRulePicker";
import type { ScreenProps } from "../../../types";

export function GatewayRuleListScreen(props: ScreenProps) {
  const { gatewayId } = useParams();
  const navigate = useNavigate();

  if (!gatewayId) {
    return (
      <GatewayPicker
        {...props}
        breadcrumb={["agentcore", "gateway", "rule", "list"]}
        description="choose a Gateway to list Rules for"
        onSelect={(id) => navigate(`/agentcore/gateway/rule/list/${encodeURIComponent(id)}`)}
      />
    );
  }

  return (
    <GatewayRulePicker
      {...props}
      gatewayId={gatewayId}
      breadcrumb={["agentcore", "gateway", "rule", "list", gatewayId]}
      onSelect={(ruleId) =>
        navigate(
          `/agentcore/gateway/rule/get/${encodeURIComponent(gatewayId)}/${encodeURIComponent(ruleId)}`,
        )
      }
    />
  );
}
