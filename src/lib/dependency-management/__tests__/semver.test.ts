import { compareVersions, parseSpecifier, parseVersion } from '../semver';
import { describe, expect, it } from 'vitest';

describe('parseVersion', () => {
  it('parses release versions', () => {
    expect(parseVersion('2.261.0')).toEqual({ major: 2, minor: 261, patch: 0, prerelease: [] });
  });

  it('parses prerelease versions with numeric identifiers', () => {
    expect(parseVersion('0.1.0-alpha.19')).toEqual({ major: 0, minor: 1, patch: 0, prerelease: ['alpha', 19] });
  });

  it('ignores build metadata', () => {
    expect(parseVersion('1.2.3+build.5')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
  });

  it('accepts a single leading v, like npm', () => {
    expect(parseVersion('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseVersion('V10.7.0')).toEqual({ major: 10, minor: 7, patch: 0, prerelease: [] });
    expect(parseVersion('vv1.2.3')).toBeNull();
  });

  it('rejects non-versions', () => {
    expect(parseVersion('latest')).toBeNull();
    expect(parseVersion('1.2')).toBeNull();
    expect(parseVersion('')).toBeNull();
  });
});

describe('compareVersions', () => {
  const v = (s: string) => parseVersion(s)!;

  it('orders by major, minor, patch', () => {
    expect(compareVersions(v('1.0.0'), v('2.0.0'))).toBeLessThan(0);
    expect(compareVersions(v('2.1.0'), v('2.0.9'))).toBeGreaterThan(0);
    expect(compareVersions(v('2.0.1'), v('2.0.1'))).toBe(0);
  });

  it('orders prerelease identifiers numerically (alpha.19 < alpha.20)', () => {
    expect(compareVersions(v('0.1.0-alpha.19'), v('0.1.0-alpha.20'))).toBeLessThan(0);
    expect(compareVersions(v('0.1.0-alpha.20'), v('0.1.0-alpha.19'))).toBeGreaterThan(0);
  });

  it('ranks prerelease below its release (0.1.0-alpha.45 < 0.1.0)', () => {
    expect(compareVersions(v('0.1.0-alpha.45'), v('0.1.0'))).toBeLessThan(0);
  });

  it('ranks numeric prerelease identifiers below alphanumeric', () => {
    expect(compareVersions(v('1.0.0-1'), v('1.0.0-alpha'))).toBeLessThan(0);
  });

  it('ranks a shorter prerelease set below a longer one', () => {
    expect(compareVersions(v('1.0.0-alpha'), v('1.0.0-alpha.1'))).toBeLessThan(0);
  });
});

describe('parseSpecifier', () => {
  it('classifies exact, tilde, and caret', () => {
    expect(parseSpecifier('2.1126.0').kind).toBe('exact');
    expect(parseSpecifier('~2.261.0').kind).toBe('tilde');
    expect(parseSpecifier('^0.1.0-alpha.19').kind).toBe('caret');
    expect(parseSpecifier('=1.2.3').kind).toBe('exact');
  });

  it('accepts v-prefixed versions, bare and ranged, like npm', () => {
    expect(parseSpecifier('v1.2.3')).toEqual({
      kind: 'exact',
      version: { major: 1, minor: 2, patch: 3, prerelease: [] },
      raw: 'v1.2.3',
    });
    expect(parseSpecifier('~v1.2.3')).toEqual({
      kind: 'tilde',
      version: { major: 1, minor: 2, patch: 3, prerelease: [] },
      raw: '~v1.2.3',
    });
    expect(parseSpecifier('^v10.7.0').kind).toBe('caret');
  });

  it('marks non-semver specifiers unsupported', () => {
    for (const raw of [
      'file:bundled-agentcore-cdk.tgz',
      'git+https://github.com/aws/agentcore-cdk.git',
      'workspace:*',
      '*',
      'latest',
      '>=1.0.0 <2.0.0',
      '1.x',
      'https://example.com/pkg.tgz',
    ]) {
      expect(parseSpecifier(raw)).toEqual({ kind: 'unsupported', raw });
    }
  });
});
