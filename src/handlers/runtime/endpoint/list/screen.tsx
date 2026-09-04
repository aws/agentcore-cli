import { useParams } from "react-router";
import type { ScreenProps } from "../../../types";
import { RuntimeEndpointPicker } from "../../../../components/RuntimeEndpointPicker";
import { RuntimePicker } from "../../../../components/RuntimePicker";
import { useRegionNavigate } from "../../../utils";

export function RuntimeListEndpointsScreen(props: ScreenProps) {
  const navigate = useRegionNavigate();
  const { runtimeId } = useParams();

  if (!runtimeId) {
    return (
      <RuntimePicker
        {...props}
        breadcrumb={["agentcore", "runtime", "endpoint", "list"]}
        description="choose a Runtime to list endpoints for"
        onSelect={(id) => navigate(`/agentcore/runtime/endpoint/list/${encodeURIComponent(id)}`)}
      />
    );
  }

  return (
    <RuntimeEndpointPicker
      {...props}
      runtimeId={runtimeId}
      breadcrumb={["agentcore", "runtime", "endpoint", "list", runtimeId]}
      onSelect={(qualifier) =>
        navigate(
          `/agentcore/runtime/endpoint/get/${encodeURIComponent(runtimeId)}/${encodeURIComponent(qualifier)}`,
        )
      }
    />
  );
}
