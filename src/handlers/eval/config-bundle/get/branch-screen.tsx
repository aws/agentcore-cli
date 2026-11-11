import { useNavigate, useParams } from "react-router";
import { ConfigBundleBranchPicker } from "../../../../components/ConfigBundleBranchPicker";
import type { ScreenProps } from "../../../types";

function branchDetailPath(bundleId: string, branchName: string): string {
  return `/agentcore/eval/config-bundle/get/${encodeURIComponent(bundleId)}/branch/${encodeURIComponent(branchName)}`;
}

export function ConfigBundleBranchScreen(props: ScreenProps) {
  const navigate = useNavigate();
  const { bundleId } = useParams();
  if (!bundleId) return null;

  return (
    <ConfigBundleBranchPicker
      {...props}
      bundleId={bundleId}
      breadcrumb={["agentcore", "eval", "config-bundle", "get", bundleId]}
      onSelect={(branchName) => navigate(branchDetailPath(bundleId, branchName))}
      onBack={() => navigate("/agentcore/eval/config-bundle/list")}
    />
  );
}
