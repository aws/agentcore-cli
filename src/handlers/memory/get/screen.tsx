import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import { JsonDetail } from "../../../components/JsonDetail";
import { ResourceDetailScreen } from "../../../components/ResourceDetailScreen";
import type { ScreenProps } from "../../types";
import { useCoreOpts, useRegionNavigate } from "../../utils";

const ACTIONS = [
  {
    name: "detail",
    description: "show the full JSON definition",
    to: (id: string) => `/agentcore/memory/get/${encodeURIComponent(id)}/json`,
  },
  {
    name: "events",
    description: "list this Memory's events",
    to: (id: string) => `/agentcore/memory/event/list/${encodeURIComponent(id)}`,
  },
  {
    name: "records",
    description: "list this Memory's records",
    to: (id: string) => `/agentcore/memory/record/list/${encodeURIComponent(id)}`,
  },
  {
    name: "actors",
    description: "list this Memory's actors",
    to: (id: string) => `/agentcore/memory/actor/list/${encodeURIComponent(id)}`,
  },
  {
    name: "sessions",
    description: "choose an actor to list this Memory's sessions",
    to: (id: string) => `/agentcore/memory/session/list/${encodeURIComponent(id)}`,
  },
] as const;

function useMemoryDetail({ ctx, core }: ScreenProps, memoryId: string | undefined) {
  const opts = useCoreOpts(ctx);
  return useQuery({
    queryKey: ["memory", opts.region, memoryId, "full"],
    queryFn: () => core.memory.getMemory(memoryId!, "full", opts),
    enabled: memoryId !== undefined,
  });
}

export function MemoryGetScreen(props: ScreenProps) {
  const navigate = useRegionNavigate();
  const { memoryId } = useParams();
  const detail = useMemoryDetail(props, memoryId);
  const memory = detail.data?.memory;

  return (
    <ResourceDetailScreen
      breadcrumb={["agentcore", "memory", "get", memoryId ?? ""]}
      isPending={detail.isPending}
      error={detail.isError ? (detail.error as Error) : null}
      items={{
        name: memory?.name ?? "",
        id: memory?.id ?? "",
        status: memory?.status ?? "",
        eventExpiryDays: memory?.eventExpiryDuration?.toString() ?? "-",
        strategies: memory?.strategies?.length.toString() ?? "0",
        updatedAt: memory?.updatedAt?.toISOString() ?? "-",
        ...(memory?.failureReason ? { failureReason: memory.failureReason } : {}),
        arn: memory?.arn ?? "",
      }}
      actions={
        memoryId && memory
          ? ACTIONS.map((action) => ({
              name: action.name,
              description: action.description,
              onSelect: () => navigate(action.to(memoryId)),
            }))
          : []
      }
      loadingLabel="loading Memory…"
      onRetry={() => void detail.refetch()}
      selectLabel="open"
    />
  );
}

export function MemoryGetJsonScreen(props: ScreenProps) {
  const { memoryId } = useParams();
  const detail = useMemoryDetail(props, memoryId);

  return (
    <JsonDetail
      breadcrumb={["agentcore", "memory", "get", memoryId ?? "", "json"]}
      isPending={detail.isPending}
      error={detail.isError ? (detail.error as Error) : null}
      data={detail.data?.memory}
      loadingLabel="loading Memory…"
      onRetry={() => void detail.refetch()}
    />
  );
}
