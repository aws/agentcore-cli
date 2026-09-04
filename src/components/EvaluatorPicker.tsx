import type { EvaluatorSummary } from "@aws-sdk/client-bedrock-agentcore-control";
import { useNavigate } from "react-router";
import type { ScreenProps } from "../handlers/types";
import { coreOptsFromCtx } from "../handlers/utils";
import { formatTimestamp } from "./formatTimestamp";
import { PaginatedTablePicker } from "./PaginatedTablePicker";
import { TIMESTAMP_WIDTH, type DataTableColumn } from "./ui/data-table";

// EvaluatorRow is the flat, display-ready shape the table renders. It also
// satisfies DataTable's `T extends Record<string, unknown>` constraint, which the
// SDK's EvaluatorSummary interface does not.
interface EvaluatorRow extends Record<string, unknown> {
  evaluatorId: string;
  evaluatorName: string;
  evaluatorType: string;
  level: string;
  updatedAt: string;
}

export const evaluatorColumns = [
  { key: "evaluatorName", header: "name", flex: true },
  { key: "evaluatorType", header: "type", width: 12 },
  { key: "level", header: "level", width: 10 },
  {
    key: "updatedAt",
    header: "updated UTC",
    width: TIMESTAMP_WIDTH,
    render: formatTimestamp,
  },
] satisfies DataTableColumn<EvaluatorRow>[];

function toRow(evaluator: EvaluatorSummary): EvaluatorRow {
  const id = evaluator.evaluatorId ?? "";
  return {
    evaluatorId: id,
    evaluatorName: evaluator.evaluatorName ?? id,
    evaluatorType: evaluator.evaluatorType ?? "-",
    level: evaluator.level ?? "-",
    updatedAt: evaluator.updatedAt?.toISOString() ?? "-",
  };
}

export interface EvaluatorPickerProps extends ScreenProps {
  breadcrumb: string[];
  description?: string;
  onSelect: (evaluatorId: string) => void;
  onEscape?: () => void;
}

/**
 * Fetches the caller's evaluators and renders them as a navigable table.
 *
 * The shared body of every "pick an evaluator" screen (list, and — in the write
 * TUI — update/delete). Esc returns to the parent menu derived from the
 * breadcrumb unless a host supplies its own onEscape.
 */
export function EvaluatorPicker({
  ctx,
  core,
  breadcrumb,
  description,
  onSelect,
  onEscape,
}: EvaluatorPickerProps) {
  const opts = coreOptsFromCtx(ctx);
  const navigate = useNavigate();
  const goBack = onEscape ?? (() => navigate("/" + breadcrumb.slice(0, -1).join("/")));

  return (
    <PaginatedTablePicker
      breadcrumb={breadcrumb}
      description={description}
      queryKey={["evaluators", opts.region]}
      loadPage={async (token, pageSize) => {
        const response = await core.eval.listEvaluators(token, pageSize, opts);
        return {
          items: response.evaluators ?? [],
          nextToken: response.nextToken,
        };
      }}
      toRow={toRow}
      columns={evaluatorColumns}
      getValue={(row) => row.evaluatorId}
      onSelect={onSelect}
      onBack={goBack}
      loadingMessage="Loading evaluators…"
      errorMessage={(error) => `Error: ${error.message}`}
      emptyMessage="No evaluators found in this Region."
      emptyPageMessage="No evaluators on this page."
    />
  );
}
