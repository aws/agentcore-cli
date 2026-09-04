import { useParams } from "react-router";
import { GatewayPicker } from "../../../../components/GatewayPicker";
import { GatewayTargetPicker } from "../../../../components/GatewayTargetPicker";
import type { ScreenProps } from "../../../types";
import { useRegionNavigate } from "../../../utils";

export function GatewayTargetListScreen(props: ScreenProps) {
  const { gatewayId } = useParams();
  const navigate = useRegionNavigate();

  if (!gatewayId) {
    return (
      <GatewayPicker
        {...props}
        breadcrumb={["agentcore", "gateway", "target", "list"]}
        description="choose a Gateway to list Targets for"
        onSelect={(id) => navigate(`/agentcore/gateway/target/list/${encodeURIComponent(id)}`)}
      />
    );
  }

  return (
    <GatewayTargetPicker
      {...props}
      gatewayId={gatewayId}
      breadcrumb={["agentcore", "gateway", "target", "list", gatewayId]}
      onSelect={(targetId) =>
        navigate(
          `/agentcore/gateway/target/get/${encodeURIComponent(gatewayId)}/${encodeURIComponent(targetId)}`,
        )
      }
    />
  );
}
