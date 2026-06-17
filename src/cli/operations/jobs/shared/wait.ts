/**
 * Block until a job reaches a terminal state by polling engine.get().
 *
 * Used by the CLI `--wait` flag. Lives in jobs/ (not the command layer) because it's pure engine
 * lifecycle logic — poll get() until isTerminal — reusable by any caller that wants synchronous
 * completion (CLI today, potentially a TUI "wait" affordance later).
 */
import { isTerminal } from './constants';
import type { JobEngine, JobType, RecordByType } from './types';

const DEFAULT_POLL_INTERVAL_MS = 5000;

export interface WaitForTerminalOptions {
  /** Poll interval in ms (default 5000). */
  pollIntervalMs?: number;
  /** Called with the latest status string on each poll (e.g. to print progress). */
  onTick?: (status: string) => void;
}

/**
 * Poll `engine.get(type, id)` until the job is terminal (or vanishes from storage).
 * Returns the final record, or undefined if the job is no longer found locally.
 */
export async function waitForTerminal<T extends JobType>(
  engine: JobEngine,
  type: T,
  id: string,
  options: WaitForTerminalOptions = {}
): Promise<RecordByType[T] | undefined> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  for (;;) {
    const record = await engine.get(type, id);
    if (!record) return undefined;
    options.onTick?.(record.status);
    if (isTerminal(record)) return record;
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
}
