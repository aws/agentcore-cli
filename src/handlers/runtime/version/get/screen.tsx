import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";
import { JsonDetail } from "../../../../components/JsonDetail";
import type { ScreenProps } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export function RuntimeGetVersionScreen({ ctx, core }: ScreenProps) {
  const opts = coreOptsFromCtx(ctx);
  const navigate = useNavigate();
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
      loadingLabel={`Loading version ${version ?? ""} for Runtime ${runtimeId ?? ""}…`}
      onEscape={() => navigate(`/agentcore/runtime/version/list/${encodeURIComponent(runtimeId!)}`)}
      onRetry={() => void detail.refetch()}
    />
  );
}
