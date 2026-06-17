/** Shared color/format helpers for job-detail views (used by both the
 * interactive `agentcore view <type> <id>` flow and the TUI history screens). */

/** Color for an execution/job status string. */
export function statusColor(status: string): string {
  if (status === 'COMPLETED' || status === 'SUCCEEDED' || status === 'RUNNING') return 'green';
  if (status === 'PAUSED' || status === 'IN_PROGRESS' || status === 'PENDING' || status === 'COMPLETED_WITH_ERRORS')
    return 'yellow';
  if (status === 'FAILED' || status === 'STOPPED' || status === 'CANCELLED' || status === 'NOT_FOUND') return 'red';
  return 'gray';
}

/** Color for an A/B-test lifecycleStatus. */
export function lifecycleColor(status: string): string {
  if (status === 'ACTIVE') return 'green';
  if (status === 'FAILED') return 'red';
  return 'gray';
}

/** Color for an evaluation average score (0 worst — 1 best). */
export function scoreColor(score: number): string {
  if (score >= 0.8) return 'green';
  if (score >= 0.5) return 'yellow';
  return 'red';
}

/** Human-friendly short name for a recommendation type. */
export function shortTypeName(type: string): string {
  if (type === 'SYSTEM_PROMPT_RECOMMENDATION') return 'System Prompt';
  if (type === 'TOOL_DESCRIPTION_RECOMMENDATION') return 'Tool Description';
  return type;
}
