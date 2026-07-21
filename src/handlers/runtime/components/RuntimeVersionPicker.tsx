import type { AgentRuntime } from "@aws-sdk/client-bedrock-agentcore-control";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Text, useInput, useWindowSize } from "ink";
import { useNavigate } from "react-router";
import { DataTable } from "../../../components/ui/data-table";
import { darkTheme } from "../../../components/ui/_core.js";
import { Spinner } from "../../../components/ui/spinner";
import { Layout } from "../../../components/Layout";
import { usePagedList } from "../../../components/usePagedList";
import type { ScreenProps } from "../../types";
import { coreOptsFromCtx } from "../../utils";

interface RuntimeVersionRow extends Record<string, unknown> {
  version: string;
  status: string;
  lastUpdatedAt: string;
}

function toRow(runtime: AgentRuntime): RuntimeVersionRow {
  return {
    version: runtime.agentRuntimeVersion ?? "",
    status: runtime.status ?? "-",
    lastUpdatedAt: runtime.lastUpdatedAt?.toISOString() ?? "-",
  };
}

export interface RuntimeVersionPickerProps extends ScreenProps {
  runtimeId: string;
  breadcrumb: string[];
  description?: string;
  onSelect: (version: string) => void;
}

export function RuntimeVersionPicker({
  ctx,
  core,
  runtimeId,
  breadcrumb,
  description,
  onSelect,
}: RuntimeVersionPickerProps) {
  const opts = coreOptsFromCtx(ctx);
  const { columns } = useWindowSize();
  const navigate = useNavigate();
  const paging = usePagedList();
  const goBack = () => navigate(-1);
  const list = useQuery({
    queryKey: ["runtime-versions", opts.region, runtimeId, paging.pageSize, paging.token],
    queryFn: () => core.runtime.listRuntimeVersions(runtimeId, paging.token, paging.pageSize, opts),
    placeholderData: keepPreviousData,
  });

  useInput(
    (input, key) => {
      if (key.escape) {
        goBack();
        return;
      }
      if (input === "r" && list.isError) void list.refetch();
    },
    { isActive: list.isPending || list.isError },
  );

  const nextToken = list.data?.nextToken;
  const paginated = paging.pageIndex > 0 || nextToken !== undefined;
  const pageTransition = list.isFetching && !list.isPending;
  const showUpdatedAt = columns >= 90;
  const showStatus = columns >= 60;
  const statusWidth = showStatus ? 20 : 0;
  const updatedAtWidth = showUpdatedAt ? 30 : 0;
  const versionWidth = Math.max(8, columns - 2 - statusWidth - updatedAtWidth);
  const rows = (list.data?.agentRuntimes ?? [])
    .map(toRow)
    .sort((left, right) => Number(right.version) - Number(left.version));

  return (
    <Layout
      breadcrumb={breadcrumb}
      description={description}
      keyHints={[
        ...(!list.isPending && !list.isError
          ? [
              { key: "↑↓/jk", label: "navigate" },
              ...(paginated ? [{ key: "←→/hl", label: "page" }] : []),
              { key: "/", label: "filter" },
              { key: "enter", label: "select" },
            ]
          : []),
        ...(list.isError ? [{ key: "r", label: "retry" }] : []),
        { key: "esc", label: "back" },
        { key: "ctl+c", label: "quit" },
      ]}
    >
      {list.isPending ? (
        <Spinner label={`Loading versions for Runtime ${runtimeId}…`} />
      ) : list.isError ? (
        <Text color="red">
          Error loading versions for Runtime {runtimeId}: {(list.error as Error).message}
        </Text>
      ) : (
        <>
          <DataTable
            borderStyle="none"
            borderTop={false}
            borderBottom={false}
            borderRight={false}
            showFooter={false}
            showDivider={true}
            pageSize={paging.pageSize}
            selectionResetKey={`${paging.pageSize}:${paging.pageIndex}`}
            columns={[
              { key: "version", header: "version", width: versionWidth },
              ...(showStatus
                ? [{ key: "status" as const, header: "status", width: statusWidth }]
                : []),
              ...(showUpdatedAt
                ? [
                    {
                      key: "lastUpdatedAt" as const,
                      header: "lastUpdatedAt",
                      width: updatedAtWidth,
                    },
                  ]
                : []),
            ]}
            data={rows}
            emptyMessage={`No versions found for Runtime ${runtimeId}.`}
            onSelect={(row) => {
              if (row.version) onSelect(row.version);
            }}
            onEscape={goBack}
            onPrevPage={!pageTransition && paging.pageIndex > 0 ? paging.prev : undefined}
            onNextPage={!pageTransition && nextToken ? () => paging.next(nextToken) : undefined}
          />
          {(paginated || pageTransition) && (
            <Text color={darkTheme.colors.muted} dimColor>
              {pageTransition
                ? `loading page ${paging.pageIndex + 1}…`
                : `page ${paging.pageIndex + 1}${nextToken ? " · more →" : ""}`}
            </Text>
          )}
        </>
      )}
    </Layout>
  );
}
