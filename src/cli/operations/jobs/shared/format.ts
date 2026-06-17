/** Shared presentation helpers for job CLI output. */

/** Format an ISO timestamp for CLI tables/detail output (shared by all job types). */
export function formatJobDate(iso: string | undefined): string {
  if (!iso) return 'unknown';
  return new Date(iso).toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
