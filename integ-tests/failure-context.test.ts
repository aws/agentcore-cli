import { parseFailure } from '../e2e-tests/utils/failure-context.js';
import { describe, expect, it } from 'vitest';

// Unit tests for the E2E failure parser (E2E infra doc §5). Pure function over
// CLI output — no AWS needed. Surfaces the EXACT error the CLI reported, plus
// its own errorName/errorSource classification when present.
const r = (stdout = '', stderr = '') => ({ stdout, stderr });

describe('parseFailure', () => {
  it('extracts the exact error from the --json envelope', () => {
    const out = JSON.stringify({ success: false, error: 'Deploy failed: stack rolled back' });
    expect(parseFailure(r(out))).toEqual({ error: 'Deploy failed: stack rolled back' });
  });

  it('surfaces errorName/errorSource when the CLI emits a typed error', () => {
    const out = JSON.stringify({
      success: false,
      error: 'Rate exceeded',
      errorName: 'ThrottlingError',
      errorSource: 'service',
    });
    expect(parseFailure(r(out))).toEqual({
      error: 'Rate exceeded',
      errorName: 'ThrottlingError',
      errorSource: 'service',
    });
  });

  it('picks the JSON envelope even when preceded by log noise on stdout', () => {
    const out = ['building...', 'deploying...', JSON.stringify({ success: false, error: 'boom' })].join('\n');
    expect(parseFailure(r(out)).error).toBe('boom');
  });

  it('falls back to stderr when stdout is not JSON', () => {
    expect(parseFailure(r('some non-json log', 'AccessDenied: not authorized')).error).toBe(
      'AccessDenied: not authorized'
    );
  });

  it('falls back to stdout when there is no stderr and no JSON', () => {
    expect(parseFailure(r('raw failure text', '')).error).toBe('raw failure text');
  });

  it('returns a placeholder when there is no output at all', () => {
    expect(parseFailure(r('', '')).error).toBe('(no output)');
  });

  it('ignores a success envelope and falls back', () => {
    const out = JSON.stringify({ success: true, response: 'ok' });
    expect(parseFailure(r(out, 'warning on stderr')).error).toBe('warning on stderr');
  });

  it('omits errorName/errorSource when the envelope lacks them', () => {
    const parsed = parseFailure(r(JSON.stringify({ success: false, error: 'plain' })));
    expect(parsed.errorName).toBeUndefined();
    expect(parsed.errorSource).toBeUndefined();
  });
});
