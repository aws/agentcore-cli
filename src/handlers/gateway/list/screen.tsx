import { useNavigate } from "react-router";
import { GatewayPicker } from "../../../components/GatewayPicker";
import type { ScreenProps } from "../../types";

export function GatewayListScreen(props: ScreenProps) {
  const navigate = useNavigate();

  return (
    <GatewayPicker
      {...props}
      breadcrumb={["agentcore", "gateway", "list"]}
      description="list AgentCore Gateways"
      onSelect={(gatewayId) => navigate(`/agentcore/gateway/get/${encodeURIComponent(gatewayId)}`)}
    />
  );
}
