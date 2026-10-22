export const AUDIT_LEVEL = 'high';
export const AUDIT_ARGS = ['audit', `--audit-level=${AUDIT_LEVEL}`, '--omit=dev', '--json'];

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

function isBlockingSeverity(severity) {
  const minimumSeverity = SEVERITY_RANK[AUDIT_LEVEL];
  return (SEVERITY_RANK[severity] ?? Number.POSITIVE_INFINITY) >= minimumSeverity;
}

function hasNonBreakingFix(fixAvailable) {
  if (fixAvailable === true) {
    return true;
  }
  if (!fixAvailable) {
    return false;
  }
  if (typeof fixAvailable === 'object') {
    return fixAvailable.isSemVerMajor !== true;
  }
  return true;
}

function uniqueAdvisories(advisories) {
  const seen = new Set();
  return advisories.filter(advisory => {
    const key = advisory.id ?? advisory.url ?? `${advisory.packageName}:${advisory.name}:${advisory.title}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function auditAdvisories(report) {
  return Object.entries(report.vulnerabilities ?? {}).flatMap(([packageName, vulnerability]) =>
    (vulnerability.via ?? [])
      .filter(via => typeof via === 'object')
      .map(via => ({
        id: advisoryId(via.url),
        packageName,
        name: via.name,
        severity: via.severity,
        title: via.title,
        url: via.url,
        fixAvailable: vulnerability.fixAvailable,
      }))
  );
}

export function evaluateAuditReport(report, { status, now = new Date() }) {
  const advisories = auditAdvisories(report);
  const blockingSeverityAdvisories = advisories.filter(advisory => isBlockingSeverity(advisory.severity));
  const allowed = uniqueAdvisories(
    blockingSeverityAdvisories.filter(advisory => advisory.id && advisory.id in TEMPORARY_AUDIT_EXCEPTIONS)
  );
  const blocked = uniqueAdvisories(
    blockingSeverityAdvisories.filter(advisory => !advisory.id || !(advisory.id in TEMPORARY_AUDIT_EXCEPTIONS))
  );
  const errors = [];

  if (status !== 0 && status !== 1) {
    errors.push(`npm audit exited with unexpected status ${status}.`);
  }
  if (status === 0 && blockingSeverityAdvisories.length > 0) {
    errors.push('npm audit reported blocking advisories despite exiting successfully.');
  }
  if (status === 1 && blockingSeverityAdvisories.length === 0) {
    errors.push('npm audit failed, but no blocking advisories could be identified from its report.');
  }
  if (blocked.length > 0) {
    errors.push(
      `npm audit found unapproved blocking advisories: ${blocked
        .map(advisory => advisory.id ?? advisory.name ?? advisory.packageName)
        .join(', ')}.`
    );
  }

  const allowedIds = new Set(allowed.map(advisory => advisory.id));
  const unusedExceptions = Object.keys(TEMPORARY_AUDIT_EXCEPTIONS).filter(id => !allowedIds.has(id));
  if (unusedExceptions.length > 0) {
    errors.push(
      `Temporary npm audit exception(s) are no longer required: ${unusedExceptions.join(', ')}. Remove them.`
    );
  }

  for (const advisory of allowed) {
    const exception = TEMPORARY_AUDIT_EXCEPTIONS[advisory.id];
    if (now >= new Date(exception.expiresAt)) {
      errors.push(
        `Temporary npm audit exception expired: ${advisory.id}. Recheck for patched releases and remove the exception.`
      );
    }
    if (hasNonBreakingFix(advisory.fixAvailable)) {
      errors.push(
        `npm reports a non-breaking fix for temporarily allowed advisory ${advisory.id}. Apply the fix and remove the exception.`
      );
    }
  }

  return {
    ok: errors.length === 0,
    allowed,
    blocked,
    errors,
  };
}

export function parseAuditReport(stdout) {
  try {
    return { ok: true, report: JSON.parse(stdout) };
  } catch {
    return { ok: false, error: 'npm audit failed without returning valid JSON.' };
  }
}
