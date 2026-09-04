import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Text, useInput } from "ink";
import { Layout } from "./Layout";
import { usePagedList } from "./usePagedList";
import { darkTheme } from "./ui/_core.js";
import { DataTable, type DataTableColumn } from "./ui/data-table";
import { Spinner } from "./ui/spinner";

export interface TokenPage<TItem> {
  items: TItem[];
  nextToken?: string;
}

export interface PaginatedTablePickerProps<TItem, TRow extends Record<string, unknown>> {
  breadcrumb: string[];
  description?: string;
  queryKey: readonly unknown[];
  loadPage: (token: string | undefined, pageSize: number) => Promise<TokenPage<TItem>>;
  toRow: (item: TItem) => TRow;
  columns: DataTableColumn<TRow>[];
  sortRows?: (rows: TRow[]) => TRow[];
  getValue: (row: TRow) => string | undefined;
  onSelect: (value: string) => void;
  onBack: () => void;
  loadingMessage: string;
  errorMessage: (error: Error) => string;
  emptyMessage: string;
  emptyPageMessage: string;
}

export function PaginatedTablePicker<TItem, TRow extends Record<string, unknown>>({
  breadcrumb,
  description,
  queryKey,
  loadPage,
  toRow,
  columns,
  sortRows,
  getValue,
  onSelect,
  onBack,
  loadingMessage,
  errorMessage,
  emptyMessage,
  emptyPageMessage,
}: PaginatedTablePickerProps<TItem, TRow>) {
  const paging = usePagedList();
  const list = useQuery({
    queryKey: [...queryKey, paging.pageSize, paging.token],
    queryFn: () => loadPage(paging.token, paging.pageSize),
    placeholderData: keepPreviousData,
  });
  const nextToken = list.data?.nextToken;
  const paginated = paging.pageIndex > 0 || nextToken !== undefined;
  const pageTransition = list.isFetching && !list.isPending;
  const mappedRows = (list.data?.items ?? []).map(toRow);
  const rows = sortRows ? sortRows(mappedRows) : mappedRows;

  useInput(
    (input, key) => {
      if (key.escape) {
        onBack();
        return;
      }
      if (list.isError && paging.pageIndex > 0 && (key.leftArrow || input === "h")) {
        paging.prev();
        return;
      }
      if (input === "r" && list.isError) void list.refetch();
    },
    { isActive: list.isPending || list.isError || pageTransition },
  );

  return (
    <Layout
      breadcrumb={breadcrumb}
      description={description}
      keyHints={[
        ...(!list.isPending && !list.isError && !pageTransition
          ? [
              { key: "↑↓/jk", label: "navigate" },
              ...(paginated ? [{ key: "←→/hl", label: "page" }] : []),
              { key: "/", label: "filter" },
              { key: "enter", label: "select" },
            ]
          : []),
        ...(list.isError && paging.pageIndex > 0 ? [{ key: "←/h", label: "previous page" }] : []),
        ...(list.isError ? [{ key: "r", label: "retry" }] : []),
        { key: "esc", label: "back" },
        { key: "ctrl+c", label: "quit" },
      ]}
    >
      {list.isPending ? (
        <Spinner label={loadingMessage} />
      ) : list.isError ? (
        <Text color="red">{errorMessage(list.error as Error)}</Text>
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
            selectionResetKey={paging.pageSize}
            focus={!pageTransition}
            columns={columns}
            data={rows}
            emptyMessage={paginated ? emptyPageMessage : emptyMessage}
            onSelect={(row) => {
              const value = getValue(row);
              if (value) onSelect(value);
            }}
            onEscape={onBack}
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
