import React, { useState } from "react";
import cliTruncate from "cli-truncate";
import { Box, Text, useInput, useWindowSize } from "ink";
import stringWidth from "string-width";
import { darkTheme } from "../_core.js";
import type { InkUITheme } from "../_core.js";
import {
  COLUMN_GAP,
  computeColumnWidths,
  resolveBorderWidth,
  SELECTION_MARKER_WIDTH,
} from "./columnWidths.js";
import type { ColumnSizing } from "./columnWidths.js";

export type DataTableColumn<T> = {
  key: keyof T & string;
  header: string;
  align?: "left" | "center" | "right";
  render?: (value: unknown, row: T) => string;
} & ColumnSizing;

export interface DataTableProps<T> {
  columns: readonly DataTableColumn<T>[];
  data: T[];
  pageSize?: number;
  searchable?: boolean;
  searchPlaceholder?: string;
  onSelect?: (row: T, index: number) => void;
  /** Called when Escape is pressed while not in search mode (e.g. to go back). */
  onEscape?: () => void;
  /**
   * Server-side paging: when either is provided, ←/h and →/l call these
   * instead of paging the client-side rows, and the selection resets to the
   * top of the new page. Pass a callback only when that direction has a page.
   */
  onPrevPage?: () => void;
  onNextPage?: () => void;
  selectable?: boolean;
  borderStyle?: "single" | "double" | "rounded" | "bold" | "classic" | "none";
  /** Toggle individual border edges (each defaults to true when a border is shown). */
  borderTop?: boolean;
  borderBottom?: boolean;
  borderLeft?: boolean;
  borderRight?: boolean;
  /** Show the horizontal rule between the header and rows (defaults to true). */
  showDivider?: boolean;
  showFooter?: boolean;
  emptyMessage?: string;
  focus?: boolean;
  selectionResetKey?: string | number;
  theme?: InkUITheme;
}

export function DataTable<T extends Record<string, unknown>>({
  columns,
  data,
  pageSize = 10,
  searchable = true,
  onSelect,
  onEscape,
  onPrevPage,
  onNextPage,
  selectable = true,
  borderStyle = "single",
  borderTop,
  borderBottom,
  borderLeft,
  borderRight,
  showDivider = true,
  showFooter = true,
  emptyMessage = "No data",
  focus = true,
  selectionResetKey,
  theme = darkTheme,
}: DataTableProps<T>): React.ReactElement {
  const { columns: terminalWidth } = useWindowSize();
  const [selectedRow, setSelectedRow] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMode, setSearchMode] = useState(false);

  // Reset the cursor when the caller swaps datasets. Adjusting state during
  // render (rather than in an effect) applies the reset in the same frame the
  // new data first paints.
  const [prevResetKey, setPrevResetKey] = useState(selectionResetKey);
  if (prevResetKey !== selectionResetKey) {
    setPrevResetKey(selectionResetKey);
    setSelectedRow(0);
    setCurrentPage(0);
  }

  // Filter
  const filtered = data.filter((row) => {
    if (!searchQuery) return true;
    return columns.some((col) => {
      const rawValue = String(row[col.key] ?? "");
      const renderedValue = col.render ? col.render(row[col.key], row) : rawValue;
      const query = searchQuery.toLowerCase();
      return rawValue.toLowerCase().includes(query) || renderedValue.toLowerCase().includes(query);
    });
  });

  const totalPages = Math.ceil(filtered.length / pageSize);
  const pageData = filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize);

  useInput(
    (input, key) => {
      if (searchMode) {
        if (key.escape) {
          setSearchMode(false);
          setSearchQuery("");
          return;
        }
        if (key.upArrow) {
          return;
        }
        if (key.downArrow) {
          setSelectedRow(0);
          setSearchMode(false);
          return;
        }
        if (key.return) {
          setSearchMode(false);
          return;
        }
        if (key.backspace || key.delete) {
          setSelectedRow(0);
          setSearchQuery((q) => q.slice(0, -1));
          return;
        }
        if (input && !key.ctrl && !key.meta && !/\p{Cc}/u.test(input)) {
          setSelectedRow(0);
          setSearchQuery((q) => q + input);
        }
        return;
      }

      if (key.escape) {
        onEscape?.();
        return;
      }

      const serverPaged = onPrevPage !== undefined || onNextPage !== undefined;
      if (key.upArrow || input === "k") {
        if (selectedRow === 0 && searchQuery) setSearchMode(true);
        else setSelectedRow((r) => Math.max(0, r - 1));
      } else if (key.downArrow || input === "j")
        setSelectedRow((r) => Math.min(pageData.length - 1, r + 1));
      else if (key.leftArrow || input === "h") {
        if (serverPaged) {
          if (onPrevPage) {
            setSelectedRow(0);
            onPrevPage();
          }
        } else setCurrentPage((p) => Math.max(0, p - 1));
      } else if (key.rightArrow || input === "l") {
        if (serverPaged) {
          if (onNextPage) {
            setSelectedRow(0);
            onNextPage();
          }
        } else setCurrentPage((p) => Math.min(totalPages - 1, p + 1));
      } else if (searchable && input === "/") {
        setSelectedRow(0);
        setCurrentPage(0);
        setSearchMode(true);
      } else if (key.return) {
        const row = pageData[selectedRow];
        if (row) onSelect?.(row, currentPage * pageSize + selectedRow);
      } else if (input === "g") setSelectedRow(0);
      else if (input === "G") setSelectedRow(pageData.length - 1);
    },
    { isActive: focus },
  );

  const pad = (s: string, w: number, align: "left" | "center" | "right" = "left") => {
    const value = cliTruncate(s, w);
    const extra = w - stringWidth(value);
    if (align === "right") return " ".repeat(extra) + value;
    if (align === "center")
      return " ".repeat(Math.floor(extra / 2)) + value + " ".repeat(Math.ceil(extra / 2));
    return value + " ".repeat(extra);
  };

  if (columns.filter((column) => column.flex === true).length > 1) {
    return <Text color={theme.colors.error}>DataTable supports at most one flexible column.</Text>;
  }

  // Ink does not define a "none" border style and throws if it is passed through.
  const bord =
    borderStyle === "none"
      ? undefined
      : borderStyle === "rounded"
        ? "round"
        : borderStyle === "bold"
          ? "bold"
          : "single";
  const borderWidth = resolveBorderWidth({
    style: bord,
    left: borderLeft,
    right: borderRight,
  });
  const computedWidths = computeColumnWidths(columns, terminalWidth, {
    selectable,
    borderWidth,
  });
  const columnsWithWidths = columns.flatMap((column, index) => {
    const width = computedWidths.widths[index];
    return width === undefined ? [] : [{ column, width }];
  });
  const filterPrefix = "/ Filter: ";
  const filterCursor = searchMode ? "█" : "";
  const availableQueryWidth = Math.max(
    0,
    computedWidths.totalWidth - stringWidth(filterPrefix) - stringWidth(filterCursor),
  );
  const visibleSearchQuery =
    availableQueryWidth > 0
      ? cliTruncate(searchQuery, availableQueryWidth, {
          position: "start",
        })
      : "";
  const filterLine = searchMode ? (
    <Text wrap="truncate">
      <Text color={theme.colors.primary}>{filterPrefix}</Text>
      <Text color={theme.colors.text}>{visibleSearchQuery}</Text>
      <Text color={theme.colors.primary}>{filterCursor}</Text>
    </Text>
  ) : searchQuery ? (
    <Text color={theme.colors.muted} wrap="truncate">
      {filterPrefix}
      {visibleSearchQuery}
    </Text>
  ) : undefined;

  return (
    <Box flexDirection="column">
      {/* Table */}
      <Box
        flexDirection="column"
        borderStyle={bord as "single" | undefined}
        borderColor={bord ? theme.colors.border : undefined}
        borderTop={borderTop}
        borderBottom={borderBottom}
        borderLeft={borderLeft}
        borderRight={borderRight}
      >
        {/* Header */}
        <Box flexDirection="row" columnGap={COLUMN_GAP}>
          {selectable && (
            <Box width={SELECTION_MARKER_WIDTH} flexShrink={0}>
              <Text color={theme.colors.muted}> </Text>
            </Box>
          )}
          {columnsWithWidths.map(({ column, width }) => (
            <Box key={column.key} width={width} flexShrink={0}>
              <Text bold color={theme.colors.primary} wrap="truncate">
                {pad(column.header, width, column.align)}
              </Text>
            </Box>
          ))}
        </Box>

        {/* Filter input replaces the divider so filtering does not change table height. */}
        <Box flexDirection="row" width={computedWidths.totalWidth}>
          {searchable && filterLine ? (
            filterLine
          ) : (
            <Text color={theme.colors.border}>
              {showDivider ? "─".repeat(computedWidths.totalWidth) : " "}
            </Text>
          )}
        </Box>

        {/* Rows */}
        {pageData.length === 0 ? (
          <Box paddingX={1}>
            <Text color={theme.colors.muted}>{emptyMessage}</Text>
          </Box>
        ) : (
          pageData.map((row, i) => {
            const isSelected = i === selectedRow && selectable && !searchMode;
            return (
              <Box key={i} flexDirection="row" columnGap={COLUMN_GAP}>
                {selectable && (
                  <Box width={SELECTION_MARKER_WIDTH} flexShrink={0}>
                    <Text
                      color={isSelected ? theme.colors.primary : theme.colors.muted}
                      wrap="truncate"
                    >
                      {isSelected ? "❯" : " "}
                    </Text>
                  </Box>
                )}
                {columnsWithWidths.map(({ column, width }) => {
                  const val = column.render
                    ? column.render(row[column.key], row)
                    : String(row[column.key] ?? "");
                  return (
                    <Box key={column.key} width={width} flexShrink={0}>
                      <Text
                        color={isSelected ? theme.colors.text : theme.colors.muted}
                        bold={isSelected}
                        wrap="truncate"
                      >
                        {pad(val, width, column.align)}
                      </Text>
                    </Box>
                  );
                })}
              </Box>
            );
          })
        )}
      </Box>

      {/* Footer */}
      {showFooter && (
        <Box marginTop={0}>
          <Text color={theme.colors.muted} dimColor>
            Showing {currentPage * pageSize + 1}-
            {Math.min((currentPage + 1) * pageSize, filtered.length)} of {filtered.length} · Page{" "}
            {currentPage + 1}/{totalPages || 1}
            {" · "}[↑↓/jk] Row [←→/hl] Page [/] Search
          </Text>
        </Box>
      )}
    </Box>
  );
}
