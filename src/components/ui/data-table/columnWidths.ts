export const COLUMN_GAP = 1;
export const FLEX_MIN_WIDTH = 16;
export const SELECTION_MARKER_WIDTH = 1;

export type ColumnSizing =
  | { flex: true; width?: never; minWidth?: never }
  | { flex?: false; width: number; minWidth: number };

export interface ComputedColumnWidths {
  widths: (number | undefined)[];
  totalWidth: number;
}

interface FixedColumnWidth {
  index: number;
  width: number;
  minWidth: number;
}

export function resolveBorderWidth(
  borderStyle: string | undefined,
  borderLeft: boolean | undefined,
  borderRight: boolean | undefined,
): number {
  if (borderStyle === undefined) return 0;
  return Number(borderLeft !== false) + Number(borderRight !== false);
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
        minWidth: Math.min(column.minWidth, column.width),
      },
    ];
  });

  const gapCount = () => {
    const visibleColumns = fixedColumns.length + (flexIndex === -1 ? 0 : 1);
    const childCount = visibleColumns + (options.selectable ? 1 : 0);
    return Math.max(0, childCount - 1);
  };
  const fixedWidth = () => fixedColumns.reduce((total, column) => total + column.width, 0);
  const totalAtFloor = () => markerWidth + fixedWidth() + flexFloor + gapCount() * COLUMN_GAP;

  while (
    totalAtFloor() > frameWidth &&
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

  while (totalAtFloor() > frameWidth && fixedColumns.length > 0) {
    fixedColumns.pop();
  }

  const widths: (number | undefined)[] = Array.from({ length: columns.length });
  for (const column of fixedColumns) widths[column.index] = column.width;

  if (flexIndex !== -1) {
    widths[flexIndex] = Math.max(
      FLEX_MIN_WIDTH,
      frameWidth - markerWidth - fixedWidth() - gapCount() * COLUMN_GAP,
    );
  }

  const totalWidth =
    markerWidth +
    widths.reduce<number>((total, width) => total + (width ?? 0), 0) +
    gapCount() * COLUMN_GAP;

  return {
    widths,
    totalWidth,
  };
}
