import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import { JsonDetail } from "../../../../components/JsonDetail";
import type { ScreenProps } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export function ConfigBundleGetScreen({ ctx, core }: ScreenProps) {
  const opts = coreOptsFromCtx(ctx);
  const { bundleId, versionId, branchName } = useParams();
  const detail = useQuery({
    queryKey: [
      "configuration-bundle",
      opts.region,
      bundleId,
      versionId === undefined ? "branch" : "version",
      versionId ?? branchName,
    ],
    queryFn: () =>
      core.eval.getConfigurationBundle(bundleId!, versionId, branchName ?? "mainline", opts),
    enabled: bundleId !== undefined && (versionId !== undefined || branchName !== undefined),
  });

  return (
    <JsonDetail
      breadcrumb={[
        "agentcore",
        "eval",
        "config-bundle",
        "get",
        bundleId ?? "",
        ...(versionId ? [versionId] : []),
        ...(branchName ? [branchName] : []),
      ]}
      isPending={detail.isPending}
      error={detail.isError ? (detail.error as Error) : null}
      data={detail.data}
      loadingLabel={
        versionId
          ? `Loading version ${versionId} for configuration bundle ${bundleId ?? ""}…`
          : `Loading branch ${branchName ?? ""} for configuration bundle ${bundleId ?? ""}…`
      }
      onRetry={() => void detail.refetch()}
    />
  );
}
