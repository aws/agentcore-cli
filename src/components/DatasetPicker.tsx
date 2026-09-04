import type { DatasetSummary } from "@aws-sdk/client-bedrock-agentcore-control";
import { useNavigate } from "react-router";
import type { ScreenProps } from "../handlers/types";
import { coreOptsFromCtx } from "../handlers/utils";
import { formatTimestamp } from "./formatTimestamp";
import { PaginatedTablePicker } from "./PaginatedTablePicker";
import {
  COUNT_WIDTH,
  NUMERIC_ALIGN,
  STATUS_WIDTH,
  TIMESTAMP_WIDTH,
  type DataTableColumn,
} from "./ui/data-table";

interface DatasetRow extends Record<string, unknown> {
  datasetId: string;
  datasetName: string;
  status: string;
  schemaType: string;
  exampleCount: string;
  updatedAt: string;
}

export const datasetColumns = [
  { key: "datasetName", header: "name", flex: true },
  { key: "status", header: "status", width: STATUS_WIDTH },
  { key: "schemaType", header: "schema", width: 12 },
  { key: "exampleCount", header: "examples", width: COUNT_WIDTH, align: NUMERIC_ALIGN },
  {
    key: "updatedAt",
    header: "updated UTC",
    width: TIMESTAMP_WIDTH,
    render: formatTimestamp,
  },
] satisfies DataTableColumn<DatasetRow>[];

function displaySchemaType(schemaType: DatasetSummary["schemaType"]): string {
  if (schemaType === "AGENTCORE_EVALUATION_PREDEFINED_V1") return "predefined";
  if (schemaType === "AGENTCORE_EVALUATION_SIMULATED_V1") return "simulated";
  return schemaType ?? "-";
}

function toRow(dataset: DatasetSummary): DatasetRow {
  const id = dataset.datasetId ?? "";
  return {
    datasetId: id,
    datasetName: dataset.datasetName ?? id,
    status: dataset.status ?? "-",
    schemaType: displaySchemaType(dataset.schemaType),
    exampleCount: dataset.exampleCount?.toString() ?? "-",
    updatedAt: dataset.updatedAt?.toISOString() ?? "-",
  };
}

export interface DatasetPickerProps extends ScreenProps {
  breadcrumb: string[];
  description?: string;
  onSelect: (datasetId: string) => void;
  onEscape?: () => void;
}

export function DatasetPicker({
  ctx,
  core,
  breadcrumb,
  description,
  onSelect,
  onEscape,
}: DatasetPickerProps) {
  const opts = coreOptsFromCtx(ctx);
  const navigate = useNavigate();
  const goBack = onEscape ?? (() => navigate("/" + breadcrumb.slice(0, -1).join("/")));

  return (
    <PaginatedTablePicker
      breadcrumb={breadcrumb}
      description={description}
      queryKey={["datasets", opts.region]}
      loadPage={async (token, pageSize) => {
        const response = await core.eval.listDatasets(token, pageSize, opts);
        return {
          items: response.datasets ?? [],
          nextToken: response.nextToken,
        };
      }}
      toRow={toRow}
      columns={datasetColumns}
      getValue={(row) => row.datasetId}
      onSelect={onSelect}
      onBack={goBack}
      loadingMessage="Loading datasets…"
      errorMessage={(error) => `Error: ${error.message}`}
      emptyMessage="No datasets found in this Region."
      emptyPageMessage="No datasets on this page."
    />
  );
}
