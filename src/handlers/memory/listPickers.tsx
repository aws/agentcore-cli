import type { ActorSummary, SessionSummary } from "@aws-sdk/client-bedrock-agentcore";
import { PaginatedTablePicker } from "../../components/PaginatedTablePicker";
import { formatTimestamp } from "../../components/formatTimestamp";
import type { DataTableColumn } from "../../components/ui/data-table";
import type { ScreenProps } from "../types";
import { coreOptsFromCtx } from "../utils";

interface MemoryActorRow extends Record<string, unknown> {
  actorId: string;
}

const actorColumns = [
  { key: "actorId", header: "actor ID", flex: true },
] satisfies DataTableColumn<MemoryActorRow>[];

function toActorRow(actor: ActorSummary): MemoryActorRow {
  return { actorId: actor.actorId ?? "" };
}

export interface MemoryActorPickerProps extends ScreenProps {
  memoryId: string;
  breadcrumb: string[];
  description: string;
  onSelect: (actorId: string) => void;
  onBack: () => void;
}

export function MemoryActorPicker({
  ctx,
  core,
  memoryId,
  breadcrumb,
  description,
  onSelect,
  onBack,
}: MemoryActorPickerProps) {
  const opts = coreOptsFromCtx(ctx);

  return (
    <PaginatedTablePicker
      breadcrumb={breadcrumb}
      description={description}
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
      onSelect={onSelect}
      onBack={onBack}
      loadingMessage={`Loading actors for Memory ${memoryId}...`}
      errorMessage={(error) => `Error loading actors for Memory ${memoryId}: ${error.message}`}
      emptyMessage={`No actors found for Memory ${memoryId}.`}
      emptyPageMessage={`No actors on this page for Memory ${memoryId}.`}
    />
  );
}

interface MemorySessionRow extends Record<string, unknown> {
  sessionId: string;
  createdAt: string;
}

const sessionColumns = [
  { key: "sessionId", header: "session ID", flex: true },
  {
    key: "createdAt",
    header: "created UTC",
    width: 16,
    minWidth: 11,
    render: formatTimestamp,
  },
] satisfies DataTableColumn<MemorySessionRow>[];

function toSessionRow(session: SessionSummary): MemorySessionRow {
  return {
    sessionId: session.sessionId ?? "",
    createdAt: session.createdAt?.toISOString() ?? "-",
  };
}

export interface MemorySessionPickerProps extends ScreenProps {
  memoryId: string;
  actorId: string;
  breadcrumb: string[];
  description: string;
  onSelect: (sessionId: string) => void;
  onBack: () => void;
}

export function MemorySessionPicker({
  ctx,
  core,
  memoryId,
  actorId,
  breadcrumb,
  description,
  onSelect,
  onBack,
}: MemorySessionPickerProps) {
  const opts = coreOptsFromCtx(ctx);

  return (
    <PaginatedTablePicker
      breadcrumb={breadcrumb}
      description={description}
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
      onSelect={onSelect}
      onBack={onBack}
      loadingMessage={`Loading sessions for actor ${actorId}...`}
      errorMessage={(error) => `Error loading sessions for actor ${actorId}: ${error.message}`}
      emptyMessage={`No sessions found for actor ${actorId}.`}
      emptyPageMessage={`No sessions on this page for actor ${actorId}.`}
    />
  );
}
