import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import { JsonDetail } from "../../../../components/JsonDetail";
import { withoutSdkMetadata } from "../../components/withoutSdkMetadata";
import type { ScreenProps } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export function RuntimeGetEndpointScreen({ ctx, core }: ScreenProps) {
  const opts = coreOptsFromCtx(ctx);
  const { runtimeId, qualifier } = useParams();
  const detail = useQuery({
    queryKey: ["runtime-endpoint", opts.region, runtimeId, qualifier],
    queryFn: () => core.runtime.getRuntimeEndpoint(runtimeId!, qualifier!, opts),
    enabled: runtimeId !== undefined && qualifier !== undefined,
  });

  return (
    <JsonDetail
      breadcrumb={["agentcore", "runtime", "endpoint", "get", runtimeId ?? "", qualifier ?? ""]}
      isPending={detail.isPending}
      error={detail.isError ? (detail.error as Error) : null}
      data={withoutSdkMetadata(detail.data)}
      loadingLabel={`Loading endpoint ${qualifier ?? ""} for Runtime ${runtimeId ?? ""}…`}
      onRetry={() => void detail.refetch()}
    />
  );
}
