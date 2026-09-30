import { useSyncExternalStore } from "react";
import { useStdout } from "ink";
import terminalSize from "terminal-size";

export interface WindowSize {
  columns: number;
  rows: number;
}

interface ResizableStream {
  readonly columns?: number;
  readonly rows?: number;
  on(event: "resize", listener: () => void): unknown;
  off(event: "resize", listener: () => void): unknown;
}

interface SizeStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => WindowSize;
}

const stores = new WeakMap<ResizableStream, SizeStore>();

// fallbackSize matches Ink's own: piped streams report no size, so ask the
// terminal (once per resize, since it can shell out), then assume 80x24.
function fallbackSize(): WindowSize {
  const size = terminalSize();
  return { columns: size.columns || 80, rows: size.rows || 24 };
}

function storeFor(stream: ResizableStream): SizeStore {
  const existing = stores.get(stream);
  if (existing) return existing;

  const listeners = new Set<() => void>();
  let fallback: WindowSize | undefined;
  let size: WindowSize | undefined;

  const read = (): WindowSize => {
    const { columns, rows } = stream;
    if (!columns || !rows) fallback ??= fallbackSize();
    const next = { columns: columns || fallback!.columns, rows: rows || fallback!.rows };
    if (size?.columns !== next.columns || size.rows !== next.rows) size = next;
    return size;
  };
  const onResize = () => {
    fallback = undefined;
    for (const listener of listeners) listener();
  };

  const store: SizeStore = {
    subscribe: (listener) => {
      if (listeners.size === 0) stream.on("resize", onResize);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stream.off("resize", onResize);
      };
    },
    getSnapshot: read,
  };
  stores.set(stream, store);
  return store;
}

// useWindowSize is Ink's useWindowSize with one shared resize listener per
// output stream. Ink's hook adds a listener per call, so a screen with many
// dividers trips Node's MaxListenersExceededWarning.
export function useWindowSize(): WindowSize {
  const store = storeFor(useStdout().stdout);
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
