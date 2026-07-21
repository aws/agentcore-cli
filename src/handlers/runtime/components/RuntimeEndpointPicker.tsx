import type { AgentRuntimeEndpoint } from "@aws-sdk/client-bedrock-agentcore-control";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Text, useInput, useWindowSize } from "ink";
import { DataTable } from "../../../components/ui/data-table";
import { darkTheme } from "../../../components/ui/_core.js";
import { Spinner } from "../../../components/ui/spinner";
import { Layout } from "../../../components/Layout";
import { usePagedList } from "../../../components/usePagedList";
import type { ScreenProps } from "../../types";
import { coreOptsFromCtx } from "../../utils";

interface RuntimeEndpointRow extends Record<string, unknown> {
  qualifier: string;
  liveVersion: string;
  status: string;
  lastUpdatedAt: string;
}

function toRow(endpoint: AgentRuntimeEndpoint): RuntimeEndpointRow {
  return {
    qualifier: endpoint.name ?? endpoint.id ?? "",
    liveVersion: endpoint.liveVersion ?? "-",
    status: endpoint.status ?? "-",
    lastUpdatedAt: endpoint.lastUpdatedAt?.toISOString() ?? "-",
  };
}

export interface RuntimeEndpointPickerProps extends ScreenProps {
  runtimeId: string;
  breadcrumb: string[];
  description?: string;
  onSelect: (qualifier: string) => void;
  onEscape: () => void;
}

export function RuntimeEndpointPicker({
  ctx,
  core,
  runtimeId,
  breadcrumb,
  description,
  onSelect,
  onEscape,
}: RuntimeEndpointPickerProps) {
  const opts = coreOptsFromCtx(ctx);
  const { columns } = useWindowSize();
  const paging = usePagedList();
  const list = useQuery({
    queryKey: ["runtime-endpoints", opts.region, runtimeId, paging.pageSize, paging.token],
    queryFn: () =>
      core.runtime.listRuntimeEndpoints(runtimeId, paging.token, paging.pageSize, opts),
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
  const showUpdatedAt = columns >= 90;
  const showStatus = columns >= 60;
  const liveWidth = 8;
  const statusWidth = showStatus ? 20 : 0;
  const updatedAtWidth = showUpdatedAt ? 30 : 0;
  const qualifierWidth = Math.max(12, columns - 2 - liveWidth - statusWidth - updatedAtWidth);

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
        <Spinner label={`Loading endpoints for Runtime ${runtimeId}…`} />
      ) : list.isError ? (
        <Text color="red">
          Error loading endpoints for Runtime {runtimeId}: {(list.error as Error).message}
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
            columns={[
              {
                key: "qualifier",
                header: "qualifier",
                width: qualifierWidth,
              },
              { key: "liveVersion", header: "live", width: liveWidth },
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
            data={(list.data.runtimeEndpoints ?? []).map(toRow)}
            emptyMessage="This Runtime has no endpoints."
            onSelect={(row) => {
              if (row.qualifier) onSelect(row.qualifier);
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
