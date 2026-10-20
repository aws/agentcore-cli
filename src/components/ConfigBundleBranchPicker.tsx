import type { ConfigurationBundleVersionSummary } from "@aws-sdk/client-bedrock-agentcore-control";
import type { ScreenProps } from "../handlers/types";
import { coreOptsFromCtx } from "../handlers/utils";
import { formatTimestamp } from "./formatTimestamp";
import { PaginatedTablePicker } from "./PaginatedTablePicker";
import type { DataTableColumn } from "./ui/data-table";

interface ConfigBundleBranchRow extends Record<string, unknown> {
  branchName: string;
  versionId: string;
  commitMessage: string;
  versionCreatedAt: string;
}

const columns = [
  { key: "branchName", header: "branch", flex: true },
  { key: "versionId", header: "latest version", width: 20, minWidth: 10 },
  { key: "commitMessage", header: "message", width: 28, minWidth: 12 },
  {
    key: "versionCreatedAt",
    header: "updated UTC",
    width: 16,
    minWidth: 11,
    render: formatTimestamp,
  },
] satisfies DataTableColumn<ConfigBundleBranchRow>[];

function toRow(version: ConfigurationBundleVersionSummary): ConfigBundleBranchRow {
  return {
    branchName: version.lineageMetadata?.branchName ?? "",
    versionId: version.versionId ?? "",
    commitMessage: version.lineageMetadata?.commitMessage ?? "-",
    versionCreatedAt: version.versionCreatedAt?.toISOString() ?? "-",
  };
}

export interface ConfigBundleBranchPickerProps extends ScreenProps {
  bundleId: string;
  breadcrumb: string[];
  onSelect: (branchName: string) => void;
  onBack: () => void;
}

export function ConfigBundleBranchPicker({
  ctx,
  core,
  bundleId,
  breadcrumb,
  onSelect,
  onBack,
}: ConfigBundleBranchPickerProps) {
  const opts = coreOptsFromCtx(ctx);

  return (
    <PaginatedTablePicker
      breadcrumb={breadcrumb}
      description={`choose a branch for configuration bundle ${bundleId}`}
      queryKey={["configuration-bundle-branches", opts.region, bundleId]}
      loadPage={async (token, pageSize) => {
        const response = await core.eval.listConfigurationBundleVersions(
          bundleId,
          token,
          pageSize,
          opts,
          { latestPerBranch: true },
        );
        return {
          items: response.versions ?? [],
          nextToken: response.nextToken,
        };
      }}
      toRow={toRow}
      columns={columns}
      getValue={(row) => row.branchName}
      onSelect={onSelect}
      onBack={onBack}
      loadingMessage={`loading branches for configuration bundle ${bundleId}…`}
      errorMessage={(error) =>
        `Error loading branches for configuration bundle ${bundleId}: ${error.message}`
      }
      emptyMessage={`No branches found for configuration bundle ${bundleId}.`}
      emptyPageMessage={`No branches on this page for configuration bundle ${bundleId}.`}
    />
  );
}
