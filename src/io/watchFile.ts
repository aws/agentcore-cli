import { watch } from "node:fs";

export type FileWatcher = (path: string, onChange: () => void, signal: AbortSignal) => void;

/**
 * Watch one file, debouncing the editor's burst of change events into a single
 * callback. Watching stops when the signal aborts; a missing file or an
 * unsupported platform fails quietly — watching is a convenience, never load-bearing.
 */
export const watchFile: FileWatcher = (path, onChange, signal, debounceMs = 150) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const watcher = watch(path, () => {
      clearTimeout(timer);
      timer = setTimeout(onChange, debounceMs);
    });
    watcher.on("error", () => watcher.close());
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        watcher.close();
      },
      { once: true },
    );
  } catch {
    // Watching is best-effort.
  }
};
