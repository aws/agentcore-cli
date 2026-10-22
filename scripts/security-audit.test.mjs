import { allowedAdvisories, blockingAdvisories, expiredAuditExceptions } from './security-audit.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

function auditReport(advisories) {
  return {
    vulnerabilities: {
      dependency: {
        via: advisories,
      },
    },
  };
}

const bracesAdvisory = {
  name: 'braces',
  severity: 'high',
  title: 'stack-exhaustion denial of service',
  url: 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm',
};

test('allows the time-boxed braces advisory', () => {
  const report = auditReport([bracesAdvisory]);

  assert.deepEqual(blockingAdvisories(report), []);
  assert.deepEqual(allowedAdvisories(report), ['GHSA-vfj7-8cjw-p6xm']);
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

  assert.deepEqual(blockingAdvisories(report), [
    {
      id: 'GHSA-aaaa-bbbb-cccc',
      name: 'unexpected-package',
      severity: 'critical',
      title: 'unexpected vulnerability',
      url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
    },
  ]);
});

test('expires the braces exception on its review date', () => {
  assert.deepEqual(expiredAuditExceptions(new Date('2026-11-04T23:59:59.999Z')), []);
  assert.deepEqual(expiredAuditExceptions(new Date('2026-11-05T00:00:00.000Z')), ['GHSA-vfj7-8cjw-p6xm']);
});
