/**
 * Job Engine constants: storage directory names, per-type terminal-status sets,
 * capability flags, and shared validation patterns.
 */
import type { JobCapabilities, JobRecord, JobType } from './types';

/**
 * Local storage directory per job type, under `<configRoot>/.cli/`.
 * Reuses the existing directory names so the layout is unchanged.
 */
export const STORAGE_DIRS: Record<JobType, string> = {
  recommendation: 'recommendations',
  'batch-evaluation': 'batch-eval-results',
  'ab-test': 'ab-tests',
  insights: 'insights',
};

/** Human-readable label per job type, for user-facing messages (e.g. "not found" errors). */
export const JOB_TYPE_LABELS: Record<JobType, string> = {
  recommendation: 'Recommendation',
  'batch-evaluation': 'Batch evaluation',
  'ab-test': 'A/B test',
  insights: 'Insights job',
};

/** Sentinel status set when a refresh GET 404s (job deleted on the service). Terminal for both types. */
export const NOT_FOUND_STATUS = 'NOT_FOUND';

/**
 * Terminal statuses per job type. The two services emit different vocabularies, so terminality
 * is per-type — a single shared set would invent statuses neither service emits.
 * `SUCCEEDED`/`DELETING` are kept defensively for recommendations (`COMPLETED`/`FAILED` are authoritative).
 */
export const TERMINAL_STATUSES: Record<JobType, ReadonlySet<string>> = {
  recommendation: new Set(['COMPLETED', 'FAILED', 'SUCCEEDED', 'DELETING', NOT_FOUND_STATUS]),
  'batch-evaluation': new Set([
    'COMPLETED',
    'COMPLETED_WITH_ERRORS',
    'FAILED',
    'STOPPED',
    'CANCELLED',
    NOT_FOUND_STATUS,
  ]),
  // AB test: `record.status` holds lifecycle status (ACTIVE/FAILED/CREATE_FAILED).
  // `record.lifecycleStatus` holds executionStatus (RUNNING/PAUSED/STOPPED) for keybindings.
  'ab-test': new Set(['FAILED', 'CREATE_FAILED', 'UPDATE_FAILED', 'DELETE_FAILED', NOT_FOUND_STATUS]),
  insights: new Set(['COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED', 'STOPPED', NOT_FOUND_STATUS]),
};

/** Runtime capability flags (TUI display only; engine legality is enforced by types). */
export const JOB_CAPABILITIES: Record<JobType, JobCapabilities> = {
  recommendation: { canStop: false, canPause: false, canPromote: false, canDebug: false },
  'batch-evaluation': { canStop: true, canPause: false, canPromote: false, canDebug: false },
  'ab-test': { canStop: true, canPause: true, canPromote: true, canDebug: true },
  insights: { canStop: false, canPause: false, canPromote: false, canDebug: false },
};

/** Maximum character length for inline text input (system prompt or tool descriptions). */
export const MAX_INLINE_TEXT_LENGTH = 20_000;

/** Recommendation name rule: start with a letter, alphanumeric + underscore/hyphen, max 48 chars. */
export const RECOMMENDATION_NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_-]{0,47}$/;

/** Maximum number of inline spans the API accepts. */
export const MAX_INLINE_SPANS = 1000;

/** Recommendation tool name rule: alphanumeric + underscore/hyphen/dot, max 256 chars. */
export const TOOL_NAME_REGEX = /^[a-zA-Z0-9_\-.]+$/;
export const MAX_TOOL_NAME_LENGTH = 256;

/** Batch-evaluation name rule: start with a letter, then letters/digits/underscores, max 48 chars. */
export const BATCH_EVAL_NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/;

/**
 * Whether a record is in a terminal state AND fully settled (no further work on read).
 *
 * Batch-evaluation has a special case: a terminal record whose per-session results have not yet
 * been fetched from CloudWatch is treated as NOT-yet-settled, so the next get()/list() retries
 * the fetch (the output log can lag the status flip).
 */
export function isTerminal(record: JobRecord): boolean {
  if (record.error) {
    return true; // refresh retries exhausted — settled with an error
  }
  if (!TERMINAL_STATUSES[record.type].has(record.status)) {
    return false;
  }
  if (record.type === 'batch-evaluation' && record.status !== NOT_FOUND_STATUS) {
    const batch = record;
    if (!batch.resultsFetched) {
      return false; // terminal status, but results still need fetching — keep refreshable
    }
  }
  // AB test: if terminal due to failure but failureReason not yet captured, keep refreshable.
  if (record.type === 'ab-test' && record.status !== NOT_FOUND_STATUS && !record.failureReason) {
    return false;
  }
  return true;
}
