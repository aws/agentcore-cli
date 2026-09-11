import { useState } from "react";
import { useWindowSize } from "ink";

// CHROME_ROWS is everything a picker screen renders around the table rows:
// the Layout header and footer (2 each), the DataTable column-header row and
// divider/filter row, and the pagination status line.
const CHROME_ROWS = 7;

export interface PagedList {
  // pageSize is how many table rows fit the terminal — sent as maxResults so
  // one response fills the table exactly.
  pageSize: number;
  // pageIndex is the zero-based page currently shown.
  pageIndex: number;
  // token is the nextToken that fetches the current page (undefined on page 1).
  token: string | undefined;
  // next advances a page; the caller passes the current response's nextToken.
  next: (nextToken: string | undefined) => void;
  // prev steps back a page (no-op on the first page).
  prev: () => void;
}

interface PaginationState {
  pageSize: number;
  pageIndex: number;
  tokens: (string | undefined)[];
}

function initialPagination(pageSize: number): PaginationState {
  return {
    pageSize,
    pageIndex: 0,
    tokens: [undefined],
  };
}

// usePagedList holds the server-side pagination state shared by the picker
// tables: a terminal-height-derived page size and the trail of nextTokens
// leading to the current page, so ←/h can walk back through cached pages.
export function usePagedList(): PagedList {
  const { rows } = useWindowSize();
  const pageSize = Math.max(3, rows - CHROME_ROWS);

  // A resize changes maxResults, which invalidates the token trail (tokens
  // encode positions relative to the old page size) — so every read derives
  // page-1 values while state.pageSize is stale, and every write rebases onto
  // initialPagination(pageSize) first. No effect needed: state catches up on
  // the next interaction.
  const [state, setState] = useState<PaginationState>(() => initialPagination(pageSize));
  const pageSizeChanged = state.pageSize !== pageSize;
  const pageIndex = pageSizeChanged ? 0 : state.pageIndex;
  const token = pageSizeChanged ? undefined : state.tokens[state.pageIndex];

  return {
    pageSize,
    pageIndex,
    token,
    next: (nextToken) => {
      if (!nextToken) return;
      setState((current) => {
        const active = current.pageSize === pageSize ? current : initialPagination(pageSize);
        return {
          pageSize,
          pageIndex: active.pageIndex + 1,
          tokens: [...active.tokens.slice(0, active.pageIndex + 1), nextToken],
        };
      });
    },
    prev: () =>
      setState((current) => {
        const active = current.pageSize === pageSize ? current : initialPagination(pageSize);
        return {
          ...active,
          pageIndex: Math.max(0, active.pageIndex - 1),
        };
      }),
  };
}
