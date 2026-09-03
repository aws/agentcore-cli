import { useNavigate } from "react-router";
import { ConfigBundlePicker } from "../../../../components/ConfigBundlePicker";
import type { ScreenProps } from "../../../types";

export function ConfigBundleListScreen(props: ScreenProps) {
  const navigate = useNavigate();

  return (
    <ConfigBundlePicker
      {...props}
      breadcrumb={["agentcore", "eval", "config-bundle", "list"]}
      description="list configuration bundles"
      onSelect={(bundleId) =>
        navigate(`/agentcore/eval/config-bundle/get/${encodeURIComponent(bundleId)}`)
      }
    />
  );
}
