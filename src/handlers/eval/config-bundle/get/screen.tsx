import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import { JsonDetail } from "../../../../components/JsonDetail";
import type { ScreenProps } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

const DEFAULT_BRANCH = "mainline";

export function ConfigBundleGetScreen({ ctx, core }: ScreenProps) {
  const opts = coreOptsFromCtx(ctx);
  const { bundleId, versionId } = useParams();
  const detail = useQuery({
    queryKey: ["configuration-bundle", opts.region, bundleId, versionId ?? DEFAULT_BRANCH],
    queryFn: () => core.eval.getConfigurationBundle(bundleId!, versionId, DEFAULT_BRANCH, opts),
    enabled: bundleId !== undefined,
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
      ]}
      isPending={detail.isPending}
      error={detail.isError ? (detail.error as Error) : null}
      data={detail.data}
      loadingLabel={
        versionId
          ? `Loading version ${versionId} for configuration bundle ${bundleId ?? ""}…`
          : `Loading configuration bundle ${bundleId ?? ""}…`
      }
      onRetry={() => void detail.refetch()}
    />
  );
}
