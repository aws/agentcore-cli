import type { MemorySummary } from "@aws-sdk/client-bedrock-agentcore-control";
import { useNavigate } from "react-router";
import { formatTimestamp } from "../../../components/formatTimestamp";
import { PaginatedTablePicker } from "../../../components/PaginatedTablePicker";
import type { DataTableColumn } from "../../../components/ui/data-table";
import type { ScreenProps } from "../../types";
import { coreOptsFromCtx } from "../../utils";

interface MemoryRow extends Record<string, unknown> {
  memoryId: string;
  status: string;
  updatedAt: string;
}

export const memoryColumns = [
  { key: "memoryId", header: "id", flex: true },
  { key: "status", header: "status", width: 13 },
  {
    key: "updatedAt",
    header: "updated UTC",
    width: 16,
    render: formatTimestamp,
  },
] satisfies DataTableColumn<MemoryRow>[];

function toRow(memory: MemorySummary): MemoryRow {
  return {
    memoryId: memory.id ?? "",
    status: memory.status ?? "-",
    updatedAt: memory.updatedAt?.toISOString() ?? "-",
  };
}

export function MemoryListScreen({ ctx, core }: ScreenProps) {
  const opts = coreOptsFromCtx(ctx);
  const navigate = useNavigate();

  return (
    <PaginatedTablePicker
      breadcrumb={["agentcore", "memory", "list"]}
      queryKey={["memories", opts.region]}
      loadPage={async (token, pageSize) => {
        const response = await core.memory.listMemories(token, pageSize, opts);
        return {
          items: response.memories ?? [],
          nextToken: response.nextToken,
        };
      }}
      toRow={toRow}
      columns={memoryColumns}
      getValue={(row) => row.memoryId}
      onSelect={(memoryId) => navigate(`/agentcore/memory/get/${encodeURIComponent(memoryId)}`)}
      onBack={() => navigate("/agentcore/memory")}
      loadingMessage="Loading Memories…"
      errorMessage={(error) => `Error: ${error.message}`}
      emptyMessage="No Memories found in this Region."
      emptyPageMessage="No Memories on this page."
    />
  );
}
