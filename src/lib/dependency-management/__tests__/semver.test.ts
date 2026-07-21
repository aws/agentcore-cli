import { parseSpecifier, parseVersion } from '../semver';
import { describe, expect, it } from 'vitest';

describe('parseVersion', () => {
  it('parses release versions', () => {
    expect(parseVersion('2.261.0')).toMatchObject({ major: 2, minor: 261, patch: 0, prerelease: [] });
  });

  it('parses prerelease versions with numeric identifiers', () => {
    expect(parseVersion('0.1.0-alpha.19')).toMatchObject({ major: 0, minor: 1, patch: 0, prerelease: ['alpha', 19] });
  });

  it('ignores build metadata for precedence fields', () => {
    expect(parseVersion('1.2.3+build.5')).toMatchObject({ major: 1, minor: 2, patch: 3, prerelease: [] });
  });

  it('accepts a single leading v or V, like npm', () => {
    expect(parseVersion('v1.2.3')).toMatchObject({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseVersion('V10.7.0')).toMatchObject({ major: 10, minor: 7, patch: 0, prerelease: [] });
    expect(parseVersion('vv1.2.3')).toBeNull();
  });

  it('rejects non-versions', () => {
    expect(parseVersion('latest')).toBeNull();
    expect(parseVersion('1.2')).toBeNull();
    expect(parseVersion('')).toBeNull();
  });

  it('rejects wildcards and ranges (no loose or coerce parsing)', () => {
    expect(parseVersion('1.x')).toBeNull();
    expect(parseVersion('*')).toBeNull();
    expect(parseVersion('>=1.2.3')).toBeNull();
  });
});

describe('parseSpecifier', () => {
  it('classifies exact, tilde, and caret', () => {
    expect(parseSpecifier('2.1126.0').kind).toBe('exact');
    expect(parseSpecifier('~2.261.0').kind).toBe('tilde');
    expect(parseSpecifier('^0.1.0-alpha.19').kind).toBe('caret');
    expect(parseSpecifier('=1.2.3').kind).toBe('exact');
  });

  it('parses the base version of a ranged specifier', () => {
    expect(parseSpecifier('~2.261.0')).toMatchObject({
      kind: 'tilde',
      version: { major: 2, minor: 261, patch: 0, prerelease: [] },
      raw: '~2.261.0',
    });
    expect(parseSpecifier('^0.1.0-alpha.19')).toMatchObject({
      kind: 'caret',
      version: { major: 0, minor: 1, patch: 0, prerelease: ['alpha', 19] },
      raw: '^0.1.0-alpha.19',
    });
  });

  it('accepts v-prefixed versions, bare and ranged, like npm', () => {
    expect(parseSpecifier('v1.2.3')).toMatchObject({
      kind: 'exact',
      version: { major: 1, minor: 2, patch: 3, prerelease: [] },
      raw: 'v1.2.3',
    });
    expect(parseSpecifier('~v1.2.3')).toMatchObject({
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
      '>=1.2.3',
      '>=1.0.0 <2.0.0',
      '1.x',
      'https://example.com/pkg.tgz',
    ]) {
      expect(parseSpecifier(raw)).toEqual({ kind: 'unsupported', raw });
    }
  });
});
