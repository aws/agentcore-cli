import type { MemorySummary } from "@aws-sdk/client-bedrock-agentcore-control";
import { useNavigate } from "react-router";
import type { ScreenProps } from "../handlers/types";
import { useCoreOpts } from "../handlers/utils";
import { formatTimestamp } from "./formatTimestamp";
import { PaginatedTablePicker } from "./PaginatedTablePicker";
import type { DataTableColumn } from "./ui/data-table";

interface MemoryRow extends Record<string, unknown> {
  memoryId: string;
  status: string;
  updatedAt: string;
}

export const memoryColumns = [
  { key: "memoryId", header: "ID", flex: true },
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

export interface MemoryPickerProps extends ScreenProps {
  breadcrumb: string[];
  description?: string;
  onSelect: (memoryId: string) => void;
}

export function MemoryPicker({ ctx, core, breadcrumb, description, onSelect }: MemoryPickerProps) {
  const opts = useCoreOpts(ctx);
  const navigate = useNavigate();
  const goBack = () => navigate("/" + breadcrumb.slice(0, -1).join("/"));

  return (
    <PaginatedTablePicker
      breadcrumb={breadcrumb}
      description={description}
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
      onSelect={onSelect}
      onBack={goBack}
      loadingMessage="loading Memories…"
      errorMessage={(error) => `Error: ${error.message}`}
      emptyMessage="No Memories found in this Region."
      emptyPageMessage="No Memories on this page."
    />
  );
}
