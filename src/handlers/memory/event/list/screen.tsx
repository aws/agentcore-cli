import type { ActorSummary, Event, SessionSummary } from "@aws-sdk/client-bedrock-agentcore";
import { useNavigate, useParams } from "react-router";
import { MemoryPicker } from "../../../../components/MemoryPicker";
import { PaginatedTablePicker } from "../../../../components/PaginatedTablePicker";
import { formatTimestamp } from "../../../../components/formatTimestamp";
import type { DataTableColumn } from "../../../../components/ui/data-table";
import type { ScreenProps } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

interface ActorRow extends Record<string, unknown> {
  actorId: string;
}

const actorColumns = [
  { key: "actorId", header: "actor id", flex: true },
] satisfies DataTableColumn<ActorRow>[];

function toActorRow(actor: ActorSummary): ActorRow {
  return { actorId: actor.actorId ?? "" };
}

interface SessionRow extends Record<string, unknown> {
  sessionId: string;
  createdAt: string;
}

const sessionColumns = [
  { key: "sessionId", header: "session id", flex: true },
  {
    key: "createdAt",
    header: "created UTC",
    width: 16,
    minWidth: 11,
    render: formatTimestamp,
  },
] satisfies DataTableColumn<SessionRow>[];

function toSessionRow(session: SessionSummary): SessionRow {
  return {
    sessionId: session.sessionId ?? "",
    createdAt: session.createdAt?.toISOString() ?? "-",
  };
}

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

interface ActorPickerProps extends ScreenProps {
  memoryId: string;
}

function ActorPicker({ ctx, core, memoryId }: ActorPickerProps) {
  const opts = coreOptsFromCtx(ctx);
  const navigate = useNavigate();

  return (
    <PaginatedTablePicker
      breadcrumb={["agentcore", "memory", "event", "list", memoryId]}
      description="choose an actor to list sessions for"
      queryKey={["memory-actors", opts.region, memoryId]}
      loadPage={async (token, pageSize) => {
        const response = await core.memory.listActors(
          { memoryId, maxResults: pageSize, nextToken: token },
          opts,
        );
        return {
          items: response.actorSummaries ?? [],
          nextToken: response.nextToken,
        };
      }}
      toRow={toActorRow}
      columns={actorColumns}
      getValue={(row) => row.actorId}
      onSelect={(actorId) =>
        navigate(
          `/agentcore/memory/event/list/${encodeURIComponent(memoryId)}/${encodeURIComponent(actorId)}`,
        )
      }
      onBack={() => navigate(`/agentcore/memory/get/${encodeURIComponent(memoryId)}`)}
      loadingMessage={`Loading actors for Memory ${memoryId}...`}
      errorMessage={(error) => `Error loading actors for Memory ${memoryId}: ${error.message}`}
      emptyMessage={`No actors found for Memory ${memoryId}.`}
      emptyPageMessage={`No actors on this page for Memory ${memoryId}.`}
    />
  );
}

interface SessionPickerProps extends ScreenProps {
  memoryId: string;
  actorId: string;
}

function SessionPicker({ ctx, core, memoryId, actorId }: SessionPickerProps) {
  const opts = coreOptsFromCtx(ctx);
  const navigate = useNavigate();

  return (
    <PaginatedTablePicker
      breadcrumb={["agentcore", "memory", "event", "list", memoryId, actorId]}
      description="choose a session to list events for"
      queryKey={["memory-sessions", opts.region, memoryId, actorId]}
      loadPage={async (token, pageSize) => {
        const response = await core.memory.listSessions(
          { memoryId, actorId, maxResults: pageSize, nextToken: token },
          opts,
        );
        return {
          items: response.sessionSummaries ?? [],
          nextToken: response.nextToken,
        };
      }}
      toRow={toSessionRow}
      columns={sessionColumns}
      getValue={(row) => row.sessionId}
      onSelect={(sessionId) =>
        navigate(
          `/agentcore/memory/event/list/${encodeURIComponent(memoryId)}/${encodeURIComponent(actorId)}/${encodeURIComponent(sessionId)}`,
        )
      }
      onBack={() => navigate(`/agentcore/memory/event/list/${encodeURIComponent(memoryId)}`)}
      loadingMessage={`Loading sessions for actor ${actorId}...`}
      errorMessage={(error) => `Error loading sessions for actor ${actorId}: ${error.message}`}
      emptyMessage={`No sessions found for actor ${actorId}.`}
      emptyPageMessage={`No sessions on this page for actor ${actorId}.`}
    />
  );
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
      onBack={() =>
        navigate(
          `/agentcore/memory/event/list/${encodeURIComponent(memoryId)}/${encodeURIComponent(actorId)}`,
        )
      }
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
    return <ActorPicker {...props} memoryId={memoryId} />;
  }

  if (!sessionId) {
    return <SessionPicker {...props} memoryId={memoryId} actorId={actorId} />;
  }

  return <EventPicker {...props} memoryId={memoryId} actorId={actorId} sessionId={sessionId} />;
}
