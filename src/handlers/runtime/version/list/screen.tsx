import { useNavigate, useParams } from "react-router";
import type { ScreenProps } from "../../../types";
import { RuntimePicker } from "../../../../components/RuntimePicker";
import { RuntimeVersionPicker } from "../../../../components/RuntimeVersionPicker";

export function RuntimeListVersionsScreen(props: ScreenProps) {
  const navigate = useNavigate();
  const { runtimeId } = useParams();

  if (!runtimeId) {
    return (
      <RuntimePicker
        {...props}
        breadcrumb={["agentcore", "runtime", "version", "list"]}
        description="choose a Runtime to list versions for"
        onSelect={(id) => navigate(`/agentcore/runtime/version/list/${encodeURIComponent(id)}`)}
      />
    );
  }

  return (
    <RuntimeVersionPicker
      {...props}
      runtimeId={runtimeId}
      breadcrumb={["agentcore", "runtime", "version", "list", runtimeId]}
      onSelect={(version) =>
        navigate(
          `/agentcore/runtime/version/get/${encodeURIComponent(runtimeId)}/${encodeURIComponent(version)}`,
        )
      }
    />
  );
}
