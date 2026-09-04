import type { BatchEvaluationSummary } from "@aws-sdk/client-bedrock-agentcore";
import { useNavigate } from "react-router";
import type { ScreenProps } from "../handlers/types";
import { coreOptsFromCtx } from "../handlers/utils";
import { formatTimestamp } from "./formatTimestamp";
import { PaginatedTablePicker } from "./PaginatedTablePicker";
import { STATUS_WIDTH, TIMESTAMP_WIDTH, type DataTableColumn } from "./ui/data-table";

interface BatchInsightsRow extends Record<string, unknown> {
  batchEvaluationId: string;
  name: string;
  status: string;
  updatedAt: string;
}

const batchInsightsColumns = [
  { key: "name", header: "name", flex: true },
  { key: "status", header: "status", width: STATUS_WIDTH },
  {
    key: "updatedAt",
    header: "updated UTC",
    width: TIMESTAMP_WIDTH,
    render: formatTimestamp,
  },
] satisfies DataTableColumn<BatchInsightsRow>[];

function toRow(summary: BatchEvaluationSummary): BatchInsightsRow {
  const id = summary.batchEvaluationId ?? "";
  return {
    batchEvaluationId: id,
    name: summary.batchEvaluationName ?? id,
    status: summary.status ?? "-",
    updatedAt: summary.updatedAt?.toISOString() ?? "-",
  };
}

export interface BatchInsightsPickerProps extends ScreenProps {
  breadcrumb: string[];
  description?: string;
  onSelect: (batchEvaluationId: string) => void;
  onEscape?: () => void;
}

export function BatchInsightsPicker({
  ctx,
  core,
  breadcrumb,
  description,
  onSelect,
  onEscape,
}: BatchInsightsPickerProps) {
  const opts = coreOptsFromCtx(ctx);
  const navigate = useNavigate();
  const goBack = onEscape ?? (() => navigate("/" + breadcrumb.slice(0, -1).join("/")));

  return (
    <PaginatedTablePicker
      breadcrumb={breadcrumb}
      description={description}
      queryKey={["batch-insights", opts.region]}
      loadPage={async (token, pageSize) => {
        const response = await core.eval.listBatchInsights(token, pageSize, opts);
        return {
          items: response.batchEvaluations ?? [],
          nextToken: response.nextToken,
        };
      }}
      toRow={toRow}
      columns={batchInsightsColumns}
      getValue={(row) => row.batchEvaluationId}
      onSelect={onSelect}
      onBack={goBack}
      loadingMessage="Loading batch insights…"
      errorMessage={(error) => `Error: ${error.message}`}
      emptyMessage="No batch insights found in this Region."
      emptyPageMessage="No batch insights on this page."
    />
  );
}
