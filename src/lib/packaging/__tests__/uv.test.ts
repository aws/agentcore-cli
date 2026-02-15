import { detectUnavailablePlatform } from '../uv.js';
import { describe, expect, it } from 'vitest';

function result(stdout: string, stderr = '') {
  return { code: 1, stdout, stderr, signal: null as NodeJS.Signals | null };
}

describe('detectUnavailablePlatform', () => {
  it('returns null when output has no platform hints', () => {
    expect(detectUnavailablePlatform(result('Some generic error'))).toBeNull();
  });

  it('detects platform hint with manylinux tokens', () => {
    const out = 'error: No matching distribution\nplatforms: manylinux2014_aarch64, manylinux_2_28_aarch64\nhelp: ...';
    const issue = detectUnavailablePlatform(result(out));
    expect(issue).not.toBeNull();
    expect(issue!.platforms).toBeDefined();
    expect(issue!.platforms!.length).toBeGreaterThan(0);
    expect(issue!.platforms!.some(p => p.includes('manylinux'))).toBe(true);
  });

  it('detects "no wheels with a matching platform tag" message', () => {
    const out = 'error: has no wheels with a matching platform tag';
    const issue = detectUnavailablePlatform(result(out));
    expect(issue).not.toBeNull();
    expect(issue!.message).toContain('wheels');
  });

  it('detects "no compatible wheels found" message', () => {
    const issue = detectUnavailablePlatform(result('no compatible wheels found for package foo'));
    expect(issue).not.toBeNull();
  });

  it('detects "no compatible tags found" message', () => {
    const issue = detectUnavailablePlatform(result('no compatible tags found'));
    expect(issue).not.toBeNull();
  });

  it('checks stderr as well as stdout', () => {
    const issue = detectUnavailablePlatform(result('', 'has no wheels with a matching platform tag'));
    expect(issue).not.toBeNull();
  });

  it('returns message with context lines around the match', () => {
    const lines = [
      'line 1',
      'line 2',
      'line 3',
      'error: has no wheels with a matching platform tag',
      'line 5',
      'line 6',
      'line 7',
    ];
    const issue = detectUnavailablePlatform(result(lines.join('\n')));
    expect(issue).not.toBeNull();
    // Message should include context lines around the match
    expect(issue!.message).toContain('has no wheels');
  });

  it('returns null for successful output', () => {
    const out = 'Successfully installed package-1.0.0\nAll done!';
    expect(detectUnavailablePlatform({ code: 0, stdout: out, stderr: '', signal: null })).toBeNull();
  });
});
