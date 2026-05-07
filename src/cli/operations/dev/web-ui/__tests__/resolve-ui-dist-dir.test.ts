import { resolveUIDistDir } from '../web-server.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('resolveUIDistDir', () => {
  const originalEnv = process.env;
  let tmpDir: string;

  beforeEach(() => {
    process.env = { ...originalEnv };
    tmpDir = mkdtempSync(join(tmpdir(), 'resolve-ui-test-'));
    delete process.env.AGENT_INSPECTOR_PATH;
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns AGENT_INSPECTOR_PATH when env var is set and dir has index.html', () => {
    process.env.AGENT_INSPECTOR_PATH = tmpDir;
    writeFileSync(join(tmpDir, 'index.html'), '<html></html>');

    expect(resolveUIDistDir()).toBe(tmpDir);
  });

  it('skips AGENT_INSPECTOR_PATH when env var is set but dir lacks index.html', () => {
    process.env.AGENT_INSPECTOR_PATH = tmpDir;

    const result = resolveUIDistDir();
    expect(result).not.toBe(tmpDir);
  });

  it('prefers AGENT_INSPECTOR_PATH over bundled candidates', () => {
    process.env.AGENT_INSPECTOR_PATH = tmpDir;
    writeFileSync(join(tmpDir, 'index.html'), '<html></html>');

    expect(resolveUIDistDir()).toBe(tmpDir);
  });

  it('returns a bundled candidate when no env var is set and bundled path exists', () => {
    const result = resolveUIDistDir();
    // If a bundled candidate has index.html, it should be returned
    if (result) {
      expect(result).toContain('dist-assets');
    }
  });
});
