import type { BatchEvaluationSummary } from "@aws-sdk/client-bedrock-agentcore";
import { useNavigate } from "react-router";
import type { ScreenProps } from "../handlers/types";
import { coreOptsFromCtx } from "../handlers/utils";
import { formatTimestamp } from "./formatTimestamp";
import { PaginatedTablePicker } from "./PaginatedTablePicker";
import type { DataTableColumn } from "./ui/data-table";

// BatchEvaluationRow is the flat, display-ready shape the table renders. It also
// satisfies DataTable's `T extends Record<string, unknown>` constraint, which the
// SDK's BatchEvaluationSummary interface does not. The list API returns summary
// fields only; per-session results come from GetBatchEvaluation.
interface BatchEvaluationRow extends Record<string, unknown> {
  batchEvaluationId: string;
  name: string;
  status: string;
  updatedAt: string;
}

export const batchEvaluationColumns = [
  { key: "name", header: "name", flex: true },
  { key: "status", header: "status", width: 22 },
  {
    key: "updatedAt",
    header: "updated UTC",
    width: 16,
    render: formatTimestamp,
  },
] satisfies DataTableColumn<BatchEvaluationRow>[];

function toRow(summary: BatchEvaluationSummary): BatchEvaluationRow {
  const id = summary.batchEvaluationId ?? "";
  return {
    batchEvaluationId: id,
    name: summary.batchEvaluationName ?? id,
    status: summary.status ?? "-",
    updatedAt: summary.updatedAt?.toISOString() ?? "-",
  };
}

export interface BatchEvaluationPickerProps extends ScreenProps {
  breadcrumb: string[];
  description?: string;
  onSelect: (batchEvaluationId: string) => void;
  onEscape?: () => void;
}

/**
 * Fetches the caller's batch evaluations and renders them as a navigable table.
 * The shared body of every "pick a batch evaluation" screen. Esc returns to the
 * parent menu derived from the breadcrumb unless a host supplies its own onEscape.
 */
export function BatchEvaluationPicker({
  ctx,
  core,
  breadcrumb,
  description,
  onSelect,
  onEscape,
}: BatchEvaluationPickerProps) {
  const opts = coreOptsFromCtx(ctx);
  const navigate = useNavigate();
  const goBack = onEscape ?? (() => navigate("/" + breadcrumb.slice(0, -1).join("/")));

  return (
    <PaginatedTablePicker
      breadcrumb={breadcrumb}
      description={description}
      queryKey={["batch-evaluations", opts.region]}
      loadPage={async (token, pageSize) => {
        const response = await core.eval.listBatchEvaluations(token, pageSize, opts);
        return {
          items: response.batchEvaluations ?? [],
          nextToken: response.nextToken,
        };
      }}
      toRow={toRow}
      columns={batchEvaluationColumns}
      getValue={(row) => row.batchEvaluationId}
      onSelect={onSelect}
      onBack={goBack}
      loadingMessage="Loading batch evaluations…"
      errorMessage={(error) => `Error: ${error.message}`}
      emptyMessage="No batch evaluations found in this Region."
      emptyPageMessage="No batch evaluations on this page."
    />
  );
}
