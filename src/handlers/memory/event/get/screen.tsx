import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import { JsonDetail } from "../../../../components/JsonDetail";
import type { ScreenProps } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export function MemoryEventGetScreen({ ctx, core }: ScreenProps) {
  const opts = coreOptsFromCtx(ctx);
  const { memoryId, actorId, sessionId, eventId } = useParams();
  const detail = useQuery({
    queryKey: ["memory-event", opts.region, memoryId, actorId, sessionId, eventId],
    queryFn: () =>
      core.memory.getEvent(
        {
          memoryId: memoryId!,
          actorId: actorId!,
          sessionId: sessionId!,
          eventId: eventId!,
        },
        opts,
      ),
    enabled:
      memoryId !== undefined &&
      actorId !== undefined &&
      sessionId !== undefined &&
      eventId !== undefined,
  });

  return (
    <JsonDetail
      breadcrumb={[
        "agentcore",
        "memory",
        "event",
        "get",
        memoryId ?? "",
        actorId ?? "",
        sessionId ?? "",
        eventId ?? "",
      ]}
      isPending={detail.isPending}
      error={detail.isError ? (detail.error as Error) : null}
      data={detail.data?.event}
      loadingLabel={`loading Memory event ${eventId ?? ""}…`}
      onRetry={() => void detail.refetch()}
    />
  );
}
