import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const AUDIT_LEVEL = 'high';
const AUDIT_ARGS = ['audit', `--audit-level=${AUDIT_LEVEL}`, '--omit=dev', '--json'];
const SEVERITY_RANK = {
  info: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
};

export const TEMPORARY_AUDIT_EXCEPTIONS = {
  'GHSA-vfj7-8cjw-p6xm': {
    expiresAt: '2026-11-05T00:00:00.000Z',
    reason:
      'braces@3.0.3 is the latest release and has no patched version; it is pulled in through @aws-cdk/toolkit-lib.',
  },
};

function advisoryId(url) {
  return url?.match(/GHSA-[\w-]+$/)?.[0];
}

export function expiredAuditExceptions(now = new Date()) {
  return Object.entries(TEMPORARY_AUDIT_EXCEPTIONS)
    .filter(([, exception]) => now >= new Date(exception.expiresAt))
    .map(([id]) => id);
}

export function blockingAdvisories(report) {
  const minimumSeverity = SEVERITY_RANK[AUDIT_LEVEL];
  const advisories = Object.values(report.vulnerabilities ?? {}).flatMap(vulnerability =>
    (vulnerability.via ?? [])
      .filter(via => typeof via === 'object')
      .filter(via => SEVERITY_RANK[via.severity] >= minimumSeverity)
      .map(via => ({
        id: advisoryId(via.url),
        name: via.name,
        severity: via.severity,
        title: via.title,
        url: via.url,
      }))
  );

  return advisories.filter(advisory => !advisory.id || !(advisory.id in TEMPORARY_AUDIT_EXCEPTIONS));
}

export function allowedAdvisories(report) {
  return Object.values(report.vulnerabilities ?? {})
    .flatMap(vulnerability => vulnerability.via ?? [])
    .filter(via => typeof via === 'object')
    .map(via => advisoryId(via.url))
    .filter(id => id && id in TEMPORARY_AUDIT_EXCEPTIONS);
}

function main() {
  const expired = expiredAuditExceptions();
  if (expired.length > 0) {
    console.error(
      `Temporary npm audit exception(s) expired: ${expired.join(', ')}. Recheck for patched releases and remove the exception.`
    );
    process.exitCode = 1;
    return;
  }

  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npmCommand, AUDIT_ARGS, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    console.error(`Unable to run npm audit: ${result.error.message}`);
    process.exitCode = 1;
    return;
  }

  if (result.status === 0) {
    process.stdout.write(result.stdout);
    return;
  }

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    console.error('npm audit failed without returning valid JSON.');
    process.exitCode = result.status ?? 1;
    return;
  }

  const blocked = blockingAdvisories(report);
  const allowed = [...new Set(allowedAdvisories(report))];
  if (blocked.length > 0 || allowed.length === 0) {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.status ?? 1;
    return;
  }

  console.warn(`npm audit found only temporarily allowed high-severity advisories: ${allowed.join(', ')}.`);
  for (const id of allowed) {
    const exception = TEMPORARY_AUDIT_EXCEPTIONS[id];
    console.warn(`- ${id}: ${exception.reason} Exception expires ${exception.expiresAt}.`);
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (import.meta.url === entrypoint) {
  main();
}
