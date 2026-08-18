import { useNavigate, useParams } from "react-router";
import { ConfigBundlePicker } from "../../../../../components/ConfigBundlePicker";
import { ConfigBundleVersionPicker } from "../../../../../components/ConfigBundleVersionPicker";
import type { ScreenProps } from "../../../../types";

export function ConfigBundleVersionListScreen(props: ScreenProps) {
  const navigate = useNavigate();
  const { bundleId } = useParams();

  if (!bundleId) {
    return (
      <ConfigBundlePicker
        {...props}
        breadcrumb={["agentcore", "eval", "config-bundle", "version", "list"]}
        description="choose a configuration bundle to list versions for"
        onSelect={(id) =>
          navigate(`/agentcore/eval/config-bundle/version/list/${encodeURIComponent(id)}`)
        }
      />
    );
  }

  return (
    <ConfigBundleVersionPicker
      {...props}
      bundleId={bundleId}
      breadcrumb={["agentcore", "eval", "config-bundle", "version", "list", bundleId]}
      onSelect={(versionId) =>
        navigate(
          `/agentcore/eval/config-bundle/get/${encodeURIComponent(bundleId)}/${encodeURIComponent(versionId)}`,
        )
      }
      onBack={() => navigate("/agentcore/eval/config-bundle/version/list")}
    />
  );
}
