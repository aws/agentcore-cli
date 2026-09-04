import type { ConfigurationBundleVersionSummary } from "@aws-sdk/client-bedrock-agentcore-control";
import type { ScreenProps } from "../handlers/types";
import { coreOptsFromCtx } from "../handlers/utils";
import { formatTimestamp } from "./formatTimestamp";
import { PaginatedTablePicker } from "./PaginatedTablePicker";
import { TIMESTAMP_WIDTH, type DataTableColumn } from "./ui/data-table";

interface ConfigBundleVersionRow extends Record<string, unknown> {
  versionId: string;
  branchName: string;
  commitMessage: string;
  versionCreatedAt: string;
}

export const configBundleVersionColumns = [
  { key: "versionId", header: "version", width: 20, minWidth: 10 },
  { key: "branchName", header: "branch", width: 12, minWidth: 8 },
  { key: "commitMessage", header: "message", flex: true },
  {
    key: "versionCreatedAt",
    header: "created UTC",
    width: TIMESTAMP_WIDTH,
    minWidth: 11,
    render: formatTimestamp,
  },
] satisfies DataTableColumn<ConfigBundleVersionRow>[];

function toRow(version: ConfigurationBundleVersionSummary): ConfigBundleVersionRow {
  return {
    versionId: version.versionId ?? "",
    branchName: version.lineageMetadata?.branchName ?? "-",
    commitMessage: version.lineageMetadata?.commitMessage ?? "-",
    versionCreatedAt: version.versionCreatedAt?.toISOString() ?? "-",
  };
}

export interface ConfigBundleVersionPickerProps extends ScreenProps {
  bundleId: string;
  breadcrumb: string[];
  onSelect: (versionId: string) => void;
  onBack: () => void;
}

export function ConfigBundleVersionPicker({
  ctx,
  core,
  bundleId,
  breadcrumb,
  onSelect,
  onBack,
}: ConfigBundleVersionPickerProps) {
  const opts = coreOptsFromCtx(ctx);

  return (
    <PaginatedTablePicker
      breadcrumb={breadcrumb}
      queryKey={["configuration-bundle-versions", opts.region, bundleId]}
      loadPage={async (token, pageSize) => {
        const response = await core.eval.listConfigurationBundleVersions(
          bundleId,
          token,
          pageSize,
          opts,
        );
        return {
          items: response.versions ?? [],
          nextToken: response.nextToken,
        };
      }}
      toRow={toRow}
      columns={configBundleVersionColumns}
      sortRows={(rows) =>
        [...rows].sort((left, right) =>
          String(right.versionCreatedAt).localeCompare(String(left.versionCreatedAt)),
        )
      }
      getValue={(row) => row.versionId}
      onSelect={onSelect}
      onBack={onBack}
      loadingMessage="Loading configuration bundle versions…"
      errorMessage={(error) =>
        `Error loading versions for configuration bundle ${bundleId}: ${error.message}`
      }
      emptyMessage={`No versions found for configuration bundle ${bundleId}.`}
      emptyPageMessage={`No versions on this page for configuration bundle ${bundleId}.`}
    />
  );
}
