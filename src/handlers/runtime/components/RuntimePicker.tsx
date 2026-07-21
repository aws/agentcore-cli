import type { AgentRuntime } from "@aws-sdk/client-bedrock-agentcore-control";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Text, useInput, useWindowSize } from "ink";
import { DataTable } from "../../../components/ui/data-table";
import { darkTheme } from "../../../components/ui/_core.js";
import { Spinner } from "../../../components/ui/spinner";
import { Layout } from "../../../components/Layout";
import { usePagedList } from "../../../components/usePagedList";
import type { ScreenProps } from "../../types";
import { coreOptsFromCtx } from "../../utils";

interface RuntimeRow extends Record<string, unknown> {
  runtimeId: string;
  runtimeName: string;
  runtimeVersion: string;
  status: string;
  lastUpdatedAt: string;
}

function toRow(runtime: AgentRuntime): RuntimeRow {
  const runtimeId = runtime.agentRuntimeId ?? "";
  return {
    runtimeId,
    runtimeName: runtime.agentRuntimeName ?? runtimeId,
    runtimeVersion: runtime.agentRuntimeVersion ?? "-",
    status: runtime.status ?? "-",
    lastUpdatedAt: runtime.lastUpdatedAt?.toISOString() ?? "-",
  };
}

export interface RuntimePickerProps extends ScreenProps {
  breadcrumb: string[];
  description?: string;
  onSelect: (runtimeId: string) => void;
  onEscape: () => void;
}

export function RuntimePicker({
  ctx,
  core,
  breadcrumb,
  description,
  onSelect,
  onEscape,
}: RuntimePickerProps) {
  const opts = coreOptsFromCtx(ctx);
  const { columns } = useWindowSize();
  const paging = usePagedList();
  const list = useQuery({
    queryKey: ["runtimes", opts.region, paging.pageSize, paging.token],
    queryFn: () => core.runtime.listRuntimes(paging.token, paging.pageSize, opts),
    placeholderData: keepPreviousData,
  });

  useInput(
    (input, key) => {
      if (key.escape) {
        onEscape();
        return;
      }
      if (input === "r" && list.isError) void list.refetch();
    },
    { isActive: list.isPending || list.isError },
  );

  const nextToken = list.data?.nextToken;
  const paginated = paging.pageIndex > 0 || nextToken !== undefined;
  const pageTransition = list.isFetching && !list.isPending;
  const showId = columns >= 130;
  const showUpdatedAt = columns >= 90;
  const showStatus = columns >= 70;
  const versionWidth = 15;
  const statusWidth = showStatus ? 16 : 0;
  const updatedAtWidth = showUpdatedAt ? 30 : 0;
  const idWidth = showId ? Math.max(30, Math.floor(columns * 0.36)) : 0;
  const nameWidth = Math.max(
    12,
    columns - 2 - versionWidth - statusWidth - updatedAtWidth - idWidth,
  );

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
        <Spinner label="Loading Runtimes…" />
      ) : list.isError ? (
        <Text color="red">Error: {(list.error as Error).message}</Text>
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
              { key: "runtimeName", header: "name", width: nameWidth },
              ...(showId ? [{ key: "runtimeId" as const, header: "id", width: idWidth }] : []),
              { key: "runtimeVersion", header: "latestVersion", width: versionWidth },
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
            data={(list.data.agentRuntimes ?? []).map(toRow)}
            emptyMessage="No Runtimes found in this Region."
            onSelect={(row) => {
              if (row.runtimeId) onSelect(row.runtimeId);
            }}
            onEscape={onEscape}
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
