import { useNavigate } from "react-router";
import type { ScreenProps } from "../../types";
import { RuntimePicker } from "../../../components/RuntimePicker";

export function RuntimeListScreen(props: ScreenProps) {
  const navigate = useNavigate();

  return (
    <RuntimePicker
      {...props}
      breadcrumb={["agentcore", "runtime", "list"]}
      onSelect={(runtimeId) => navigate(`/agentcore/runtime/get/${encodeURIComponent(runtimeId)}`)}
    />
  );
}
