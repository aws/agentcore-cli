import { evaluateAuditReport, parseAuditReport } from './security-audit.lib.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

function auditReport(advisories, fixAvailable = false) {
  return {
    vulnerabilities: {
      dependency: {
        via: advisories,
        fixAvailable,
      },
    },
  };
}

const exceptions = {
  'GHSA-vfj7-8cjw-p6xm': {
    expiresAt: '2026-11-05T00:00:00.000Z',
    reason: 'braces@3.0.3 is the latest release and has no patched version.',
  },
};

const bracesAdvisory = {
  name: 'braces',
  severity: 'high',
  title: 'stack-exhaustion denial of service',
  url: 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm',
};

test('allows the time-boxed braces advisory', () => {
  const report = auditReport([bracesAdvisory], {
    name: '@aws-cdk/toolkit-lib',
    version: '1.15.1',
    isSemVerMajor: true,
  });
  const decision = evaluateAuditReport(report, {
    status: 1,
    now: new Date('2026-11-04T23:59:59.999Z'),
    exceptions,
  });

  assert.equal(decision.ok, true);
  assert.deepEqual(
    decision.allowed.map(advisory => advisory.id),
    ['GHSA-vfj7-8cjw-p6xm']
  );
  assert.deepEqual(decision.blocked, []);
});

test('does not allow other high-severity advisories', () => {
  const report = auditReport([
    bracesAdvisory,
    {
      name: 'unexpected-package',
      severity: 'critical',
      title: 'unexpected vulnerability',
      url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
    },
  ]);
  const decision = evaluateAuditReport(report, {
    status: 1,
    now: new Date('2026-11-04T23:59:59.999Z'),
    exceptions,
  });

  assert.equal(decision.ok, false);
  assert.deepEqual(
    decision.blocked.map(advisory => advisory.id),
    ['GHSA-aaaa-bbbb-cccc']
  );
});

for (const severity of [undefined, 'severe']) {
  test(`treats ${severity ?? 'missing'} severity as blocking`, () => {
    const report = auditReport([
      bracesAdvisory,
      {
        name: 'unexpected-package',
        severity,
        title: 'unexpected vulnerability',
        url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
      },
    ]);
    const decision = evaluateAuditReport(report, {
      status: 1,
      now: new Date('2026-11-04T23:59:59.999Z'),
      exceptions,
    });

    assert.equal(decision.ok, false);
    assert.deepEqual(
      decision.blocked.map(advisory => advisory.id),
      ['GHSA-aaaa-bbbb-cccc']
    );
  });
}

test('rejects the braces exception when a non-breaking fix is available', () => {
  for (const fixAvailable of [true, { name: 'braces', version: '3.0.4', isSemVerMajor: false }]) {
    const decision = evaluateAuditReport(auditReport([bracesAdvisory], fixAvailable), {
      status: 1,
      now: new Date('2026-11-04T23:59:59.999Z'),
      exceptions,
    });

    assert.equal(decision.ok, false);
    assert.match(decision.errors.join('\n'), /non-breaking fix/);
  }
});

test('expires the braces exception only when the audit still relies on it', () => {
  const decision = evaluateAuditReport(auditReport([bracesAdvisory]), {
    status: 1,
    now: new Date('2026-11-05T00:00:00.000Z'),
    exceptions,
  });

  assert.equal(decision.ok, false);
  assert.match(decision.errors.join('\n'), /exception expired/);
});

test('requires stale exceptions to be removed', () => {
  const decision = evaluateAuditReport({ vulnerabilities: {} }, { status: 0, exceptions });

  assert.equal(decision.ok, false);
  assert.match(decision.errors.join('\n'), /no longer required/);
});

test('fails closed when npm audit returns an unexpected status', () => {
  const decision = evaluateAuditReport(auditReport([bracesAdvisory]), {
    status: 2,
    now: new Date('2026-11-04T23:59:59.999Z'),
    exceptions,
  });

  assert.equal(decision.ok, false);
  assert.match(decision.errors.join('\n'), /unexpected status 2/);
});

test('fails closed when npm audit output is not valid JSON', () => {
  assert.deepEqual(parseAuditReport('not json'), {
    ok: false,
    error: 'npm audit failed without returning valid JSON.',
  });
});
