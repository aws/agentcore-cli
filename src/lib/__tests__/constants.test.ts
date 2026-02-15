import { getArtifactZipName } from '../constants.js';
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
