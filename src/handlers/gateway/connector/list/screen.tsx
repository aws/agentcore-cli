import { useNavigate, useParams } from "react-router";
import { GatewayConnectorPicker } from "../../../../components/GatewayConnectorPicker";
import { GatewayPicker } from "../../../../components/GatewayPicker";
import type { ScreenProps } from "../../../types";

export function GatewayConnectorListScreen(props: ScreenProps) {
  const { gatewayId } = useParams();
  const navigate = useNavigate();

  if (!gatewayId) {
    return (
      <GatewayPicker
        {...props}
        breadcrumb={["agentcore", "gateway", "connector", "list"]}
        description="choose a Gateway to list connectors for"
        onSelect={(id) => navigate(`/agentcore/gateway/connector/list/${encodeURIComponent(id)}`)}
      />
    );
  }

  return (
    <GatewayConnectorPicker
      {...props}
      gatewayId={gatewayId}
      breadcrumb={["agentcore", "gateway", "connector", "list", gatewayId]}
      onSelect={(targetId) =>
        navigate(
          `/agentcore/gateway/connector/get/${encodeURIComponent(gatewayId)}/${encodeURIComponent(targetId)}`,
        )
      }
    />
  );
}
