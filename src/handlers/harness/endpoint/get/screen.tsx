import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import type { ScreenProps } from "../../../types";
import { useCoreOpts } from "../../../utils";
import { JsonDetail } from "../../../../components/JsonDetail";

// HarnessGetEndpointScreen shows one endpoint's full definition as scrollable
// JSON. The harness ID and endpoint name come from the route path values.
export function HarnessGetEndpointScreen({ ctx, core }: ScreenProps) {
  const opts = useCoreOpts(ctx);
  const { harnessId, endpointName } = useParams();

  const detail = useQuery({
    queryKey: ["harness-endpoint", opts.region, harnessId, endpointName],
    queryFn: () => core.harness.getHarnessEndpoint(harnessId!, endpointName!, opts),
    enabled: harnessId !== undefined && endpointName !== undefined,
  });

  return (
    <JsonDetail
      breadcrumb={["agentcore", "harness", "endpoint", "get", harnessId ?? "", endpointName ?? ""]}
      isPending={detail.isPending}
      error={detail.isError ? (detail.error as Error) : null}
      data={detail.data?.endpoint}
      loadingLabel="loading endpoint…"
    />
  );
}
