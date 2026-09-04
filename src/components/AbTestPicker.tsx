import type { ABTestSummary } from "@aws-sdk/client-bedrock-agentcore";
import { useNavigate } from "react-router";
import type { ScreenProps } from "../handlers/types";
import { useCoreOpts } from "../handlers/utils";
import { formatTimestamp } from "./formatTimestamp";
import { PaginatedTablePicker } from "./PaginatedTablePicker";
import type { DataTableColumn } from "./ui/data-table";

interface AbTestRow extends Record<string, unknown> {
  abTestId: string;
  name: string;
  status: string;
  executionStatus: string;
  updatedAt: string;
}

export const abTestColumns = [
  { key: "name", header: "name", flex: true },
  { key: "status", header: "status", width: 14 },
  { key: "executionStatus", header: "execution", width: 12 },
  { key: "updatedAt", header: "updated UTC", width: 16, render: formatTimestamp },
] satisfies DataTableColumn<AbTestRow>[];

function toRow(summary: ABTestSummary): AbTestRow {
  const id = summary.abTestId ?? "";
  return {
    abTestId: id,
    name: summary.name ?? id,
    status: summary.status ?? "-",
    executionStatus: summary.executionStatus ?? "-",
    updatedAt: summary.updatedAt?.toISOString() ?? "-",
  };
}

export interface AbTestPickerProps extends ScreenProps {
  breadcrumb: string[];
  description?: string;
  onSelect: (abTestId: string) => void;
  onEscape?: () => void;
}

export function AbTestPicker({
  ctx,
  core,
  breadcrumb,
  description,
  onSelect,
  onEscape,
}: AbTestPickerProps) {
  const opts = useCoreOpts(ctx);
  const navigate = useNavigate();
  const goBack = onEscape ?? (() => navigate("/" + breadcrumb.slice(0, -1).join("/")));

  return (
    <PaginatedTablePicker
      breadcrumb={breadcrumb}
      description={description}
      queryKey={["ab-tests", opts.region]}
      loadPage={async (token, pageSize) => {
        const response = await core.eval.listABTests(token, pageSize, opts);
        return { items: response.abTests ?? [], nextToken: response.nextToken };
      }}
      toRow={toRow}
      columns={abTestColumns}
      getValue={(row) => row.abTestId}
      onSelect={onSelect}
      onBack={goBack}
      loadingMessage="loading A/B tests…"
      errorMessage={(error) => `Error: ${error.message}`}
      emptyMessage="No A/B tests found in this Region."
      emptyPageMessage="No A/B tests on this page."
    />
  );
}
