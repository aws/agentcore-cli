import type { ConfigurationBundleSummary } from "@aws-sdk/client-bedrock-agentcore-control";
import { useNavigate } from "react-router";
import type { ScreenProps } from "../handlers/types";
import { coreOptsFromCtx } from "../handlers/utils";
import { formatTimestamp } from "./formatTimestamp";
import { PaginatedTablePicker } from "./PaginatedTablePicker";
import type { DataTableColumn } from "./ui/data-table";

interface ConfigBundleRow extends Record<string, unknown> {
  bundleId: string;
  bundleName: string;
  description: string;
  createdAt: string;
}

export const configBundleColumns = [
  { key: "bundleName", header: "name", flex: true },
  { key: "description", header: "description", width: 28, minWidth: 12 },
  {
    key: "createdAt",
    header: "created UTC",
    width: 16,
    minWidth: 11,
    render: formatTimestamp,
  },
] satisfies DataTableColumn<ConfigBundleRow>[];

function toRow(bundle: ConfigurationBundleSummary): ConfigBundleRow {
  const id = bundle.bundleId ?? "";
  return {
    bundleId: id,
    bundleName: bundle.bundleName ?? id,
    description: bundle.description ?? "-",
    createdAt: bundle.createdAt?.toISOString() ?? "-",
  };
}

export interface ConfigBundlePickerProps extends ScreenProps {
  breadcrumb: string[];
  description?: string;
  onSelect: (bundleId: string) => void;
  onEscape?: () => void;
}

export function ConfigBundlePicker({
  ctx,
  core,
  breadcrumb,
  description,
  onSelect,
  onEscape,
}: ConfigBundlePickerProps) {
  const opts = coreOptsFromCtx(ctx);
  const navigate = useNavigate();
  const goBack = onEscape ?? (() => navigate("/" + breadcrumb.slice(0, -1).join("/")));

  return (
    <PaginatedTablePicker
      breadcrumb={breadcrumb}
      description={description}
      queryKey={["configuration-bundles", opts.region]}
      loadPage={async (token, pageSize) => {
        const response = await core.eval.listConfigurationBundles(token, pageSize, opts);
        return {
          items: response.bundles ?? [],
          nextToken: response.nextToken,
        };
      }}
      toRow={toRow}
      columns={configBundleColumns}
      getValue={(row) => row.bundleId}
      onSelect={onSelect}
      onBack={goBack}
      loadingMessage="Loading configuration bundles…"
      errorMessage={(error) => `Error: ${error.message}`}
      emptyMessage="No configuration bundles found in this Region."
      emptyPageMessage="No configuration bundles on this page."
    />
  );
}
