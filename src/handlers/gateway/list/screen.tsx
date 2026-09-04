import { GatewayPicker } from "../../../components/GatewayPicker";
import type { ScreenProps } from "../../types";
import { useRegionNavigate } from "../../utils";

export function GatewayListScreen(props: ScreenProps) {
  const navigate = useRegionNavigate();

  return (
    <GatewayPicker
      {...props}
      breadcrumb={["agentcore", "gateway", "list"]}
      description="list AgentCore Gateways"
      onSelect={(gatewayId) => navigate(`/agentcore/gateway/get/${encodeURIComponent(gatewayId)}`)}
    />
  );
}
