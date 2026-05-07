import { resolveUserDockerfile } from '../useAddAgent';
import { resolve } from 'path';
import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// resolveUserDockerfile — regression tests for issue #1128
//
// The CLI must resolve a user-supplied Dockerfile path relative to the
// directory the user invoked the CLI from (cwd), NOT relative to the
// project root or codeLocation. Bare filenames are passed through
// unchanged so the rendered template default keeps working.
// ---------------------------------------------------------------------------

describe('resolveUserDockerfile', () => {
  it('returns copy:false for undefined', () => {
    const result = resolveUserDockerfile(undefined, '/some/cwd');
    expect(result).toEqual({ ok: true, copy: false, filename: undefined });
  });

  it('returns copy:false for empty string', () => {
    const result = resolveUserDockerfile('', '/some/cwd');
    expect(result).toEqual({ ok: true, copy: false, filename: undefined });
  });

  it('returns copy:false for a bare filename and preserves the name', () => {
    // A bare filename is the schema-valid value persisted in the project spec.
    // We must not try to copy it; we must keep it as-is.
    const fileExists = vi.fn(() => false);
    const result = resolveUserDockerfile('Dockerfile', '/some/cwd', fileExists);
    expect(result).toEqual({ ok: true, copy: false, filename: 'Dockerfile' });
    // Importantly: existsSync is NOT consulted for a bare filename, so a
    // user-supplied "Dockerfile" never gets a misleading "not found" error.
    expect(fileExists).not.toHaveBeenCalled();
  });

  it('resolves a relative path against cwd (not project root)', () => {
    const fileExists = vi.fn(() => true);
    const cwd = '/home/user/.github';
    const result = resolveUserDockerfile('./Dockerfile.dev', cwd, fileExists);

    expect(result).toEqual({
      ok: true,
      copy: true,
      sourcePath: resolve(cwd, './Dockerfile.dev'),
      filename: 'Dockerfile.dev',
    });
    expect(fileExists).toHaveBeenCalledWith(resolve(cwd, './Dockerfile.dev'));
  });

  it('resolves a nested relative path against cwd', () => {
    const fileExists = vi.fn(() => true);
    const cwd = '/home/user/.github';
    const result = resolveUserDockerfile('subdir/Dockerfile.gpu', cwd, fileExists);

    expect(result).toEqual({
      ok: true,
      copy: true,
      sourcePath: resolve(cwd, 'subdir/Dockerfile.gpu'),
      filename: 'Dockerfile.gpu',
    });
  });

  it('honors absolute paths regardless of cwd', () => {
    const fileExists = vi.fn(() => true);
    const result = resolveUserDockerfile('/tmp/MyDockerfile', '/home/user', fileExists);

    expect(result).toEqual({
      ok: true,
      copy: true,
      sourcePath: resolve('/tmp/MyDockerfile'),
      filename: 'MyDockerfile',
    });
  });

  it('returns ok:false with a cwd-resolved path when source file is missing', () => {
    const fileExists = vi.fn(() => false);
    const cwd = '/home/user/.github';
    const result = resolveUserDockerfile('./missing.Dockerfile', cwd, fileExists);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Error message must point at the cwd-resolved path so users can see
      // the actual filesystem location that was checked.
      expect(result.error).toContain(resolve(cwd, './missing.Dockerfile'));
      expect(result.error).toMatch(/Dockerfile not found at/);
    }
  });

  it('does not resolve relative to projectRoot/codeLocation (regression for #1128)', () => {
    // The reporter's scenario: cwd is a sub-directory like ".github", but
    // the project root and BYO codeLocation are different. The resolver
    // must use cwd, not <projectRoot>/<codeLocation>.
    const cwd = '/workspace/proj/.github';
    const projectRoot = '/workspace/proj';
    const codeLocation = 'harnesses/';

    const fileExists = vi.fn((p: string) => p === resolve(cwd, './my.Dockerfile'));

    const result = resolveUserDockerfile('./my.Dockerfile', cwd, fileExists);

    expect(result.ok).toBe(true);
    if (result.ok && result.copy) {
      expect(result.sourcePath).toBe(resolve(cwd, './my.Dockerfile'));
      expect(result.sourcePath).not.toBe(resolve(projectRoot, codeLocation, './my.Dockerfile'));
    }
  });
});
