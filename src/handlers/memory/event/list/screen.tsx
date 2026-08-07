import type { Event } from "@aws-sdk/client-bedrock-agentcore";
import { useNavigate, useParams } from "react-router";
import { MemoryPicker } from "../../../../components/MemoryPicker";
import { PaginatedTablePicker } from "../../../../components/PaginatedTablePicker";
import { formatTimestamp } from "../../../../components/formatTimestamp";
import type { DataTableColumn } from "../../../../components/ui/data-table";
import type { ScreenProps } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";
import { MemoryActorPicker, MemorySessionPicker } from "../../listPickers";

interface EventRow extends Record<string, unknown> {
  eventId: string;
  branch: string;
  occurredAt: string;
}

const eventColumns = [
  { key: "eventId", header: "event id", flex: true },
  { key: "branch", header: "branch", width: 18, minWidth: 8 },
  {
    key: "occurredAt",
    header: "occurred UTC",
    width: 16,
    minWidth: 11,
    render: formatTimestamp,
  },
] satisfies DataTableColumn<EventRow>[];

function toEventRow(event: Event): EventRow {
  return {
    eventId: event.eventId ?? "",
    branch: event.branch?.name ?? "-",
    occurredAt: event.eventTimestamp?.toISOString() ?? "-",
  };
}

interface EventPickerProps extends ScreenProps {
  memoryId: string;
  actorId: string;
  sessionId: string;
}

function EventPicker({ ctx, core, memoryId, actorId, sessionId }: EventPickerProps) {
  const opts = coreOptsFromCtx(ctx);
  const navigate = useNavigate();

  return (
    <PaginatedTablePicker
      breadcrumb={["agentcore", "memory", "event", "list", memoryId, actorId, sessionId]}
      queryKey={["memory-events", opts.region, memoryId, actorId, sessionId]}
      loadPage={async (token, pageSize) => {
        const response = await core.memory.listEvents(
          {
            memoryId,
            actorId,
            sessionId,
            maxResults: pageSize,
            nextToken: token,
          },
          opts,
        );
        return {
          items: response.events ?? [],
          nextToken: response.nextToken,
        };
      }}
      toRow={toEventRow}
      columns={eventColumns}
      getValue={(row) => row.eventId}
      onSelect={(eventId) =>
        navigate(
          `/agentcore/memory/event/get/${encodeURIComponent(memoryId)}/${encodeURIComponent(actorId)}/${encodeURIComponent(sessionId)}/${encodeURIComponent(eventId)}`,
        )
      }
      onBack={() => navigate(-1)}
      loadingMessage={`Loading events for session ${sessionId}...`}
      errorMessage={(error) => `Error loading events for session ${sessionId}: ${error.message}`}
      emptyMessage={`No events found for session ${sessionId}.`}
      emptyPageMessage={`No events on this page for session ${sessionId}.`}
    />
  );
}

export function MemoryEventListScreen(props: ScreenProps) {
  const navigate = useNavigate();
  const { memoryId, actorId, sessionId } = useParams();

  if (!memoryId) {
    return (
      <MemoryPicker
        {...props}
        breadcrumb={["agentcore", "memory", "event", "list"]}
        description="choose a Memory to list events for"
        onSelect={(id) => navigate(`/agentcore/memory/event/list/${encodeURIComponent(id)}`)}
      />
    );
  }

  if (!actorId) {
    return (
      <MemoryActorPicker
        {...props}
        memoryId={memoryId}
        breadcrumb={["agentcore", "memory", "event", "list", memoryId]}
        description="choose an actor to list sessions for"
        onSelect={(id) =>
          navigate(
            `/agentcore/memory/event/list/${encodeURIComponent(memoryId)}/${encodeURIComponent(id)}`,
          )
        }
        onBack={() => navigate(-1)}
      />
    );
  }

  if (!sessionId) {
    return (
      <MemorySessionPicker
        {...props}
        memoryId={memoryId}
        actorId={actorId}
        breadcrumb={["agentcore", "memory", "event", "list", memoryId, actorId]}
        description="choose a session to list events for"
        onSelect={(id) =>
          navigate(
            `/agentcore/memory/event/list/${encodeURIComponent(memoryId)}/${encodeURIComponent(actorId)}/${encodeURIComponent(id)}`,
          )
        }
        onBack={() => navigate(-1)}
      />
    );
  }

  return <EventPicker {...props} memoryId={memoryId} actorId={actorId} sessionId={sessionId} />;
}
