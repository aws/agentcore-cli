import { getArtifactZipName, getDockerfilePath } from '../constants.js';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

describe('getArtifactZipName', () => {
  it('appends .zip to the name', () => {
    expect(getArtifactZipName('my-agent')).toBe('my-agent.zip');
  });

  it('works with simple names', () => {
    expect(getArtifactZipName('tool')).toBe('tool.zip');
  });

  it('works with empty string', () => {
    expect(getArtifactZipName('')).toBe('.zip');
  });

  it('does not strip existing extension', () => {
    expect(getArtifactZipName('agent.tar')).toBe('agent.tar.zip');
  });
});

describe('getDockerfilePath', () => {
  it('returns default Dockerfile when no custom name given', () => {
    expect(getDockerfilePath('/app/code')).toBe(join('/app/code', 'Dockerfile'));
  });

  it('returns custom dockerfile name joined to the build context', () => {
    expect(getDockerfilePath('/app/code', 'Dockerfile.gpu')).toBe(join('/app/code', 'Dockerfile.gpu'));
  });

  it('allows a relative subpath within the build context', () => {
    expect(getDockerfilePath('/app/code', 'path/to/Dockerfile')).toBe(join('/app/code', 'path/to/Dockerfile'));
  });

  it('rejects an absolute dockerfile path', () => {
    expect(() => getDockerfilePath('/app/code', '/etc/Dockerfile')).toThrow(/Invalid dockerfile path/);
  });

  it('rejects leading dot-dot traversal', () => {
    expect(() => getDockerfilePath('/app/code', '../Dockerfile')).toThrow(/Invalid dockerfile path/);
  });

  it('rejects a dot-dot traversal segment mid-path', () => {
    expect(() => getDockerfilePath('/app/code', 'a/../secret')).toThrow(/Invalid dockerfile path/);
  });

  it('rejects backslash in dockerfile path', () => {
    expect(() => getDockerfilePath('/app/code', 'Dockerfile\\..\\secret')).toThrow(/Invalid dockerfile path/);
  });

  it('rejects a bare dot-dot', () => {
    expect(() => getDockerfilePath('/app/code', '..')).toThrow(/Invalid dockerfile path/);
  });
});
