export const COLUMN_GAP = 1;
export const FLEX_MIN_WIDTH = 16;
export const SELECTION_MARKER_WIDTH = 1;
/**
 * How wide a flexible column may grow before the leftover terminal width is
 * left as right margin instead. Without a ceiling the flexible column absorbs
 * every spare cell, so on a wide terminal the identifier ends up separated
 * from its own metadata by a canyon of blank space.
 */
export const FLEX_MAX_WIDTH = 40;

export type ColumnSizing =
  | { flex: true; maxWidth?: number; width?: never; minWidth?: never }
  | { flex?: false; width: number; minWidth?: number };

export type ComputedColumnWidths = {
  widths: (number | undefined)[];
  totalWidth: number;
};

type FixedColumnWidth = {
  index: number;
  width: number;
  minWidth: number;
};

export function resolveBorderWidth({
  style,
  left,
  right,
}: {
  style?: string;
  left?: boolean;
  right?: boolean;
}): number {
  if (style === undefined) return 0;
  return Number(left !== false) + Number(right !== false);
}

export function computeColumnWidths(
  columns: readonly ColumnSizing[],
  terminalWidth: number,
  options: { selectable: boolean; borderWidth: number },
): ComputedColumnWidths {
  const flexIndex = columns.findIndex((column) => column.flex === true);
  const frameWidth = Math.max(0, terminalWidth - options.borderWidth);
  const markerWidth = options.selectable ? SELECTION_MARKER_WIDTH : 0;
  const flexFloor = flexIndex === -1 ? 0 : FLEX_MIN_WIDTH;
  const fixedColumns: FixedColumnWidth[] = columns.flatMap((column, index) => {
    if (column.flex === true) return [];

    return [
      {
        index,
        width: column.width,
        minWidth: Math.min(column.minWidth ?? column.width, column.width),
      },
    ];
  });

  const visibleFixedWidth = () => fixedColumns.reduce((total, column) => total + column.width, 0);
  const gapWidth = () => {
    const visibleColumns = fixedColumns.length + (flexIndex === -1 ? 0 : 1);
    // Ink inserts columnGap between adjacent children; the selection marker is also a child.
    const childCount = visibleColumns + (options.selectable ? 1 : 0);
    return Math.max(0, childCount - 1) * COLUMN_GAP;
  };
  const minimumTableWidth = () => markerWidth + visibleFixedWidth() + flexFloor + gapWidth();

  while (
    minimumTableWidth() > frameWidth &&
    fixedColumns.some((column) => column.width > column.minWidth)
  ) {
    for (let index = fixedColumns.length - 1; index >= 0; index -= 1) {
      const column = fixedColumns[index]!;
      if (column.width > column.minWidth) {
        column.width -= 1;
        break;
      }
    }
  }

  while (minimumTableWidth() > frameWidth && fixedColumns.length > 0) {
    fixedColumns.pop();
  }

  const widths: (number | undefined)[] = Array.from({ length: columns.length });
  for (const column of fixedColumns) widths[column.index] = column.width;

  if (flexIndex !== -1) {
    const flexColumn = columns[flexIndex]!;
    const ceiling = flexColumn.flex === true ? (flexColumn.maxWidth ?? FLEX_MAX_WIDTH) : undefined;
    const available = frameWidth - markerWidth - visibleFixedWidth() - gapWidth();
    widths[flexIndex] = Math.max(
      FLEX_MIN_WIDTH,
      ceiling === undefined ? available : Math.min(available, ceiling),
    );
  }

  const totalWidth =
    markerWidth + widths.reduce<number>((total, width) => total + (width ?? 0), 0) + gapWidth();

  return {
    widths,
    totalWidth,
  };
}
