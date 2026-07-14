import { type RunResult, spawnAndCollect } from '../../src/test-utils/index.js';

/**
 * Structured failure debugging for E2E tests (E2E infra doc §5). When a CLI
 * step fails, on-call scrolls a wall of raw stdout/stderr. This surfaces the
 * *exact* error first, plus the CLI's own classification when available, plus
 * (best-effort) the CloudFormation events that explain a deploy failure.
 */

/** Parsed view of a failed `--json` CLI result. */
export interface ParsedFailure {
  /** The exact error message the CLI reported (the thing you actually want). */
  error: string;
  /** The CLI's own error class, e.g. "ThrottlingError" — present when the CLI
   *  emits a typed BaseError via serializeResult(). */
  errorName?: string;
  /** The CLI's own source classification: user | client | service | unknown. */
  errorSource?: string;
}

/**
 * Extract the exact error from a failed CLI result. Prefers the structured
 * `{ success: false, error, errorName?, errorSource? }` JSON the CLI prints with
 * `--json`; falls back to raw stderr (then stdout) when the output isn't JSON.
 * Pure — no network/fs — so it's unit-testable.
 */
export function parseFailure(result: Pick<RunResult, 'stdout' | 'stderr'>): ParsedFailure {
  // The JSON envelope is usually the last non-empty stdout line.
  const lines = result.stdout
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.startsWith('{')) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (obj.success === false && typeof obj.error === 'string') {
        return {
          error: obj.error,
          errorName: typeof obj.errorName === 'string' ? obj.errorName : undefined,
          errorSource: typeof obj.errorSource === 'string' ? obj.errorSource : undefined,
        };
      }
    } catch {
      /* not JSON — keep scanning */
    }
  }
  const fallback = result.stderr.trim() || result.stdout.trim() || '(no output)';
  return { error: fallback };
}

export interface DumpFailureOptions {
  /** Label for the failing step, e.g. "deploy" / "invoke". */
  label: string;
  result: RunResult;
  cwd: string;
  /** CloudFormation stack to pull failed events from (deploy failures). */
  stackName?: string;
  region?: string;
  /** Sink for output; defaults to console.log. Injectable for tests. */
  log?: (msg: string) => void;
}

/** Query CloudFormation for the events that explain a failed deploy. */
async function fetchFailedStackEvents(stackName: string, region: string, cwd: string): Promise<string | undefined> {
  const events = await spawnAndCollect(
    'aws',
    [
      'cloudformation',
      'describe-stack-events',
      '--stack-name',
      stackName,
      '--query',
      // Only events that carry a failure reason — filter out the noise.
      "StackEvents[?contains(ResourceStatus, 'FAILED') || contains(ResourceStatus, 'ROLLBACK')].{Resource:LogicalResourceId,Status:ResourceStatus,Reason:ResourceStatusReason}",
      '--output',
      'json',
      '--region',
      region,
    ],
    cwd
  );
  if (events.exitCode === 0 && events.stdout.trim() && events.stdout.trim() !== '[]') {
    return events.stdout;
  }
  return undefined;
}

/**
 * Emit a single structured failure report instead of scattered console.logs.
 * Leads with the exact error; adds the CLI's own errorName/errorSource when
 * present. Best-effort context fetch — never throws (a debug helper must not
 * mask the real assertion).
 */
export async function dumpFailureContext(opts: DumpFailureOptions): Promise<void> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const region = opts.region ?? process.env.AWS_REGION ?? 'us-east-1';
  const parsed = parseFailure(opts.result);

  const lines: string[] = [];
  lines.push(`\n──────── E2E failure: ${opts.label} (exit ${opts.result.exitCode}) ────────`);
  // The exact error, first and prominent.
  lines.push(`▸ error: ${parsed.error}`);
  if (parsed.errorName) {
    lines.push(`▸ type: ${parsed.errorName}${parsed.errorSource ? ` (source: ${parsed.errorSource})` : ''}`);
  }
  // Full raw output stays available below the summary for anything the parse missed.
  lines.push(`▸ stdout:\n${opts.result.stdout}`);
  lines.push(`▸ stderr:\n${opts.result.stderr}`);
  log(lines.join('\n'));

  // Deploy failures: pull the CloudFormation events the CLI output doesn't have.
  try {
    if (opts.stackName) {
      const events = await fetchFailedStackEvents(opts.stackName, region, opts.cwd);
      if (events) log(`▸ CloudFormation failed/rollback events for ${opts.label}:\n${events}`);
    }
  } catch {
    // A debug helper must never mask the real test failure.
    log(`▸ (failed to fetch CloudFormation events for ${opts.label})`);
  }
}
