import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import { JsonDetail } from "../../../../components/JsonDetail";
import type { ScreenProps } from "../../../types";
import { useCoreOpts } from "../../../utils";

export function RuntimeGetVersionScreen({ ctx, core }: ScreenProps) {
  const opts = useCoreOpts(ctx);
  const { runtimeId, version } = useParams();
  const detail = useQuery({
    queryKey: ["runtime-version", opts.region, runtimeId, version],
    queryFn: () => core.runtime.getRuntimeVersion(runtimeId!, version!, opts),
    enabled: runtimeId !== undefined && version !== undefined,
  });

  return (
    <JsonDetail
      breadcrumb={["agentcore", "runtime", "version", "get", runtimeId ?? "", version ?? ""]}
      isPending={detail.isPending}
      error={detail.isError ? (detail.error as Error) : null}
      data={detail.data}
      loadingLabel={`loading version ${version ?? ""} for Runtime ${runtimeId ?? ""}…`}
      onRetry={() => void detail.refetch()}
    />
  );
}
