import { resolveUIDistDir } from '../web-server.js';
import fs from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    vi.restoreAllMocks();
  });

  it('returns null when no candidate has index.html', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    expect(resolveUIDistDir()).toBeNull();
  });

  it('returns AGENT_INSPECTOR_PATH when env var is set and dir has index.html', () => {
    process.env.AGENT_INSPECTOR_PATH = tmpDir;
    writeFileSync(join(tmpDir, 'index.html'), '');

    expect(resolveUIDistDir()).toBe(tmpDir);
  });

  it('skips AGENT_INSPECTOR_PATH when env var is set but dir lacks index.html', () => {
    process.env.AGENT_INSPECTOR_PATH = tmpDir;
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    expect(resolveUIDistDir()).toBeNull();
  });

  it('prefers AGENT_INSPECTOR_PATH over bundled candidates', () => {
    process.env.AGENT_INSPECTOR_PATH = tmpDir;
    writeFileSync(join(tmpDir, 'index.html'), '');

    expect(resolveUIDistDir()).toBe(tmpDir);
  });
});
