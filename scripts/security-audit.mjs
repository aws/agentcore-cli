import {
  AUDIT_ARGS,
  TEMPORARY_AUDIT_EXCEPTIONS,
  evaluateAuditReport,
  parseAuditReport,
} from './security-audit.lib.mjs';
import { spawnSync } from 'node:child_process';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npmCommand, AUDIT_ARGS, {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});

if (result.error) {
  console.error(`Unable to run npm audit: ${result.error.message}`);
  process.exitCode = 1;
} else if (result.signal || !Number.isInteger(result.status)) {
  console.error(`npm audit did not complete normally${result.signal ? ` (signal: ${result.signal})` : ''}.`);
  process.exitCode = 1;
} else {
  const parsed = parseAuditReport(result.stdout);
  if (!parsed.ok) {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    console.error(parsed.error);
    process.exitCode = result.status || 1;
  } else {
    const decision = evaluateAuditReport(parsed.report, { status: result.status });
    if (!decision.ok) {
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      for (const error of decision.errors) {
        console.error(error);
      }
      process.exitCode = result.status || 1;
    } else if (decision.allowed.length > 0) {
      const allowedIds = decision.allowed.map(advisory => advisory.id);
      console.warn(`npm audit found only temporarily allowed high-severity advisories: ${allowedIds.join(', ')}.`);
      for (const id of allowedIds) {
        const exception = TEMPORARY_AUDIT_EXCEPTIONS[id];
        console.warn(`- ${id}: ${exception.reason} Exception expires ${exception.expiresAt}.`);
      }
    } else {
      process.stdout.write(result.stdout);
    }
  }
}
