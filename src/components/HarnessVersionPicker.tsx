import { useNavigate } from "react-router";
import type { HarnessVersionSummary } from "@aws-sdk/client-bedrock-agentcore-control";
import type { ScreenProps } from "../handlers/types";
import { coreOptsFromCtx } from "../handlers/utils";
import { TokenPagedTablePicker } from "./TokenPagedTablePicker";

// VersionRow is the flat, display-ready shape the table renders.
interface VersionRow extends Record<string, unknown> {
  harnessVersion: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

function toRow(v: HarnessVersionSummary): VersionRow {
  return {
    harnessVersion: v.harnessVersion!,
    status: v.status!,
    createdAt: v.createdAt!.toISOString(),
    updatedAt: v.updatedAt!.toISOString(),
  };
}

export interface HarnessVersionPickerProps extends ScreenProps {
  // harnessId scopes the listing to one harness's versions.
  harnessId: string;
  // breadcrumb labels the screen the picker is serving.
  breadcrumb: string[];
  // description tells the user what selecting a version will do.
  description?: string;
  // onSelect receives the chosen version (e.g. "2").
  onSelect: (version: string) => void;
}

/**
 * Fetches a harness's versions and renders them as a navigable table, newest first.
 *
 * Esc pops back.
 */
export function HarnessVersionPicker({
  ctx,
  core,
  harnessId,
  breadcrumb,
  description,
  onSelect,
}: HarnessVersionPickerProps) {
  const opts = coreOptsFromCtx(ctx);
  const navigate = useNavigate();
  const goBack = () => navigate(-1);

  return (
    <TokenPagedTablePicker
      breadcrumb={breadcrumb}
      description={description}
      queryKey={["harness-versions", opts.region, harnessId]}
      loadPage={async (token, pageSize) => {
        const response = await core.harness.listHarnessVersions(harnessId, token, pageSize, opts);
        return {
          items: response.harnessVersions ?? [],
          nextToken: response.nextToken,
        };
      }}
      toRow={toRow}
      columns={[
        { key: "harnessVersion", header: "version" },
        { key: "status", header: "status" },
        { key: "createdAt", header: "createdAt" },
      ]}
      sortRows={(rows) =>
        [...rows].sort((left, right) => Number(right.harnessVersion) - Number(left.harnessVersion))
      }
      getValue={(row) => row.harnessVersion}
      onSelect={onSelect}
      onBack={goBack}
      loadingMessage="Loading versions…"
      errorMessage={(error) => `Error: ${error.message}`}
      emptyMessage="No versions found."
      emptyPageMessage={`No versions on this page for harness ${harnessId}.`}
    />
  );
}
