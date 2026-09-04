import type { ScreenProps } from "../../types";
import { RuntimePicker } from "../../../components/RuntimePicker";
import { useRegionNavigate } from "../../utils";

export function RuntimeListScreen(props: ScreenProps) {
  const navigate = useRegionNavigate();

  return (
    <RuntimePicker
      {...props}
      breadcrumb={["agentcore", "runtime", "list"]}
      description="list AgentCore Runtimes"
      onSelect={(runtimeId) => navigate(`/agentcore/runtime/get/${encodeURIComponent(runtimeId)}`)}
    />
  );
}
