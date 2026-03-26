/**
 * Output settling monitor for the TUI test harness.
 *
 * Detects when terminal output has "settled" — meaning no more meaningful
 * text changes are occurring. This is used to know when a TUI screen is
 * fully rendered and ready for assertions or input.
 *
 * The core insight: cursor blink and other cosmetic writes (attribute
 * changes, cursor repositioning) fire `onWriteParsed` but do NOT change
 * the text content returned by `translateToString()`. By comparing text
 * snapshots, we filter out cosmetic noise and only reset the silence
 * timer when actual text changes occur.
 *
 * Import pattern (proven in Phase 1 proof-of-concept):
 *   import xtermHeadless from '@xterm/headless';
 *   const { Terminal } = xtermHeadless;
 *
 * The package's "main" is a CJS bundle. With verbatimModuleSyntax + bundler
 * resolution, a default import gets the module.exports object.
 */
import xtermHeadless from '@xterm/headless';

const { Terminal } = xtermHeadless;
type Terminal = InstanceType<typeof Terminal>;

/** Default number of milliseconds of text silence before considering output settled. */
const DEFAULT_WAIT_MS = 300;

/** Multiplier applied to the settle wait to compute the hard ceiling timeout. */
const HARD_CEILING_MULTIPLIER = 3;

/**
 * Monitors a terminal for output settling — the point at which no more
 * meaningful text changes are occurring.
 *
 * Usage:
 * ```ts
 * const monitor = new SettlingMonitor(terminal);
 * const settled = await monitor.waitForSettle();
 * if (settled) {
 *   // Screen is stable, safe to read or interact
 * }
 * monitor.dispose();
 * ```
 */
export class SettlingMonitor {
  private terminal: Terminal;
  private defaultWaitMs: number;
  private disposed: boolean;
  private disposeHandlers: { dispose(): void }[];

  constructor(terminal: Terminal, options?: { defaultWaitMs?: number }) {
    this.terminal = terminal;
    this.defaultWaitMs = options?.defaultWaitMs ?? DEFAULT_WAIT_MS;
    this.disposed = false;
    this.disposeHandlers = [];
  }

  /**
   * Wait until terminal output settles (no text changes for `waitMs`
   * milliseconds), or until the hard ceiling timeout is reached.
   *
   * @param waitMs - Milliseconds of text silence required. Defaults to
   *   the value provided in the constructor options (300ms).
   * @returns `true` if output settled within the time limit, `false` if
   *   the hard ceiling was reached or the monitor was disposed.
   */
  waitForSettle(waitMs?: number): Promise<boolean> {
    const effectiveWaitMs = waitMs ?? this.defaultWaitMs;
    const hardCeilingMs = effectiveWaitMs * HARD_CEILING_MULTIPLIER;

    if (this.disposed) {
      return Promise.resolve(false);
    }

    return new Promise<boolean>(resolve => {
      let resolved = false;

      const cleanup = (): void => {
        if (writeListener) {
          writeListener.dispose();
          // Remove from disposeHandlers so we don't try to double-dispose
          const idx = this.disposeHandlers.indexOf(disposeEntry);
          if (idx !== -1) {
            this.disposeHandlers.splice(idx, 1);
          }
        }
        clearTimeout(silenceTimer);
        clearTimeout(ceilingTimer);
      };

      const finish = (settled: boolean): void => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve(settled);
      };

      // Take the initial text snapshot of the viewport.
      let lastSnapshot = this.takeSnapshot();

      // Start the silence timer. If it fires without being reset, output
      // has settled.
      let silenceTimer = setTimeout(() => {
        finish(true);
      }, effectiveWaitMs);

      // Hard ceiling prevents infinite waiting when output keeps changing.
      const ceilingTimer = setTimeout(() => {
        finish(false);
      }, hardCeilingMs);

      // Listen for parsed writes. On each write, compare the new text to
      // the previous snapshot. Only reset the silence timer if text actually
      // changed (filtering out cursor blink and other cosmetic writes).
      const writeListener = this.terminal.onWriteParsed(() => {
        if (resolved) return;

        const newSnapshot = this.takeSnapshot();

        if (newSnapshot !== lastSnapshot) {
          // Text changed — update baseline and reset silence timer.
          lastSnapshot = newSnapshot;
          clearTimeout(silenceTimer);
          silenceTimer = setTimeout(() => {
            finish(true);
          }, effectiveWaitMs);
        }
        // If text is the same, this was a cosmetic write (cursor blink,
        // attribute change). Do nothing — let the silence timer continue.
      });

      // Create a dispose entry that can abort this waitForSettle call
      // if dispose() is called externally.
      const disposeEntry = {
        dispose(): void {
          finish(false);
        },
      };
      this.disposeHandlers.push(disposeEntry);
    });
  }

  /**
   * Clean up all listeners and timers. Any in-progress `waitForSettle`
   * call will resolve with `false`.
   */
  dispose(): void {
    this.disposed = true;

    // Copy the array since finish() modifies disposeHandlers via splice.
    const handlers = [...this.disposeHandlers];
    for (const handler of handlers) {
      handler.dispose();
    }
    this.disposeHandlers = [];
  }

  /**
   * Take a text snapshot of the current viewport.
   *
   * Reads each visible line from the active buffer using
   * `translateToString(true)` (which trims trailing whitespace).
   * The resulting lines are joined with newlines to form a single
   * comparable string.
   */
  private takeSnapshot(): string {
    const buf = this.terminal.buffer.active;
    const lines: string[] = [];
    for (let i = buf.baseY; i < buf.baseY + this.terminal.rows; i++) {
      lines.push(buf.getLine(i)?.translateToString(true) ?? '');
    }
    return lines.join('\n');
  }
}
