import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import type { ScreenProps } from "../../../types";
import { useCoreOpts } from "../../../utils";
import { JsonDetail } from "../../../../components/JsonDetail";

// HarnessGetVersionScreen shows one harness version's full definition as
// scrollable JSON. The harness ID and version come from the route path values.
export function HarnessGetVersionScreen({ ctx, core }: ScreenProps) {
  const opts = useCoreOpts(ctx);
  const { harnessId, version } = useParams();

  const detail = useQuery({
    queryKey: ["harness-version", opts.region, harnessId, version],
    queryFn: () => core.harness.getHarnessVersion(harnessId!, version!, opts),
    enabled: harnessId !== undefined && version !== undefined,
  });

  return (
    <JsonDetail
      breadcrumb={["agentcore", "harness", "version", "get", harnessId ?? "", version ?? ""]}
      isPending={detail.isPending}
      error={detail.isError ? (detail.error as Error) : null}
      data={detail.data?.harness}
      loadingLabel="loading version…"
    />
  );
}
