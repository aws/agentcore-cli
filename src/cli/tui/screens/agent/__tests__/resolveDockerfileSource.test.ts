import { resolveDockerfileSource } from '../useAddAgent';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Regression tests for issue #1128: the Dockerfile picker in the agent BYO
 * wizard must resolve user-supplied paths relative to the directory the user
 * invoked `agentcore` from, NOT relative to the (possibly not-yet-created)
 * project's code directory.
 */
describe('resolveDockerfileSource', () => {
  it('returns null for undefined (no dockerfile selected)', () => {
    expect(resolveDockerfileSource(undefined)).toBeNull();
  });

  it('returns null for empty string (user pressed Enter for default)', () => {
    expect(resolveDockerfileSource('')).toBeNull();
  });

  it('returns null for a bare filename (no slash)', () => {
    // A bare filename means the file is expected to already live inside the
    // build context's code directory; no copy is needed.
    expect(resolveDockerfileSource('Dockerfile')).toBeNull();
    expect(resolveDockerfileSource('Dockerfile.dev')).toBeNull();
  });

  it('resolves a relative path against the supplied cwd, not against any project root', () => {
    const cwd = '/home/user/workplace/.github';
    expect(resolveDockerfileSource('docker/MyDockerfile.dev', cwd)).toBe(resolve(cwd, 'docker/MyDockerfile.dev'));
  });

  it('resolves a nested relative path against the supplied cwd', () => {
    const cwd = '/home/user/workplace/.github';
    expect(resolveDockerfileSource('subdir/MyDockerfile', cwd)).toBe(resolve(cwd, 'subdir/MyDockerfile'));
  });

  it('resolves "./Dockerfile" against the supplied cwd', () => {
    const cwd = '/home/user/workplace/.github';
    // "./Dockerfile" contains "/", so it is treated as a real path, not a
    // bare filename. resolve() collapses the "./" segment.
    expect(resolveDockerfileSource('./Dockerfile', cwd)).toBe(resolve(cwd, 'Dockerfile'));
  });

  it('preserves absolute paths (they are not re-rooted)', () => {
    const cwd = '/home/user/workplace/.github';
    const abs = '/tmp/elsewhere/Dockerfile';
    expect(resolveDockerfileSource(abs, cwd)).toBe(abs);
  });

  it('defaults to process.cwd() when no cwd argument is supplied', () => {
    const original = process.cwd();
    expect(resolveDockerfileSource('subdir/Dockerfile')).toBe(resolve(original, 'subdir/Dockerfile'));
  });

  it('does NOT resolve relative to a project root (regression for #1128)', () => {
    // The bug: previously the picker rooted at <projectRoot>/<codeLocation>,
    // e.g. /home/user/.github/myproj/app/myagent/. A user typing
    // "MyDockerfile" from /home/user/.github would have it looked up at
    // /home/user/.github/myproj/app/myagent/MyDockerfile — wrong.
    const cwd = '/home/user/workplace/.github';
    const resolved = resolveDockerfileSource('subdir/MyDockerfile', cwd);
    expect(resolved).toBe('/home/user/workplace/.github/subdir/MyDockerfile');
    expect(resolved).not.toContain('/app/');
    expect(resolved).not.toContain('/myproj/');
  });
});
