import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";
import type { ScreenProps } from "../../types";
import { coreOptsFromCtx } from "../../utils";
import { JsonDetail } from "../../../components/JsonDetail";
import { ResourceDetailScreen } from "../../../components/ResourceDetailScreen";

// The actions offered for a harness, in menu order. Each routes into the
// corresponding flow with the harness preselected.
const ACTIONS: { name: string; description: string; to: (id: string) => string }[] = [
  {
    name: "detail",
    description: "show the full JSON definition",
    to: (id) => `/agentcore/harness/get/${id}/json`,
  },
  {
    name: "endpoints",
    description: "list this harness's endpoints",
    to: (id) => `/agentcore/harness/endpoint/list/${id}`,
  },
  {
    name: "versions",
    description: "list this harness's versions",
    to: (id) => `/agentcore/harness/version/list/${id}`,
  },
  {
    name: "invoke",
    description: "chat with this harness",
    to: (id) => `/agentcore/harness/invoke/${id}`,
  },
  {
    name: "exec",
    description: "run shell commands in this harness",
    to: (id) => `/agentcore/harness/exec/${id}`,
  },
  {
    name: "update",
    description: "update this harness",
    to: (id) => `/agentcore/harness/update/${id}`,
  },
];

// HarnessGetScreen is the hub for a single harness: a summary overlay (name,
// ARN, execution role, status) above an action selector that jumps into the
// harness's flows (detail JSON, endpoints, versions, invoke, exec). The harness
// ID comes from the `:harnessId` route path value.
function useHarnessDetail({ ctx, core }: ScreenProps, harnessId: string | undefined) {
  const opts = coreOptsFromCtx(ctx);
  return useQuery({
    queryKey: ["harness", opts.region, harnessId],
    queryFn: () => core.harness.getHarness(harnessId!, opts),
    enabled: harnessId !== undefined,
  });
}

export function HarnessGetScreen(props: ScreenProps) {
  const navigate = useNavigate();
  const { harnessId } = useParams();
  const detail = useHarnessDetail(props, harnessId);
  const harness = detail.data?.harness;

  return (
    <ResourceDetailScreen
      breadcrumb={["agentcore", "harness", "get", harnessId ?? ""]}
      isPending={detail.isPending}
      error={detail.isError ? (detail.error as Error) : null}
      items={{
        id: harness?.harnessId ?? "",
        status: harness?.status ?? "",
        version: harness?.harnessVersion?.toString() ?? "0",
        arn: harness?.arn ?? "",
      }}
      actions={
        harnessId && harness
          ? ACTIONS.map((action) => ({
              name: action.name,
              description: action.description,
              onSelect: () => navigate(action.to(harnessId)),
            }))
          : []
      }
      loadingLabel="loading harness…"
      onRetry={() => void detail.refetch()}
    />
  );
}

// HarnessGetJsonScreen renders the harness's full definition as scrollable JSON
// (the hub's "detail" action).
export function HarnessGetJsonScreen(props: ScreenProps) {
  const { harnessId } = useParams();
  const detail = useHarnessDetail(props, harnessId);

  return (
    <JsonDetail
      breadcrumb={["agentcore", "harness", "get", harnessId ?? "", "json"]}
      isPending={detail.isPending}
      error={detail.isError ? (detail.error as Error) : null}
      data={detail.data?.harness}
      loadingLabel="loading harness…"
      onRetry={() => void detail.refetch()}
    />
  );
}
