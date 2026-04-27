import { resolveUIDistDir } from '../web-server.js';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs');

const existsSync = vi.mocked(fs.existsSync);

describe('resolveUIDistDir', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.AGENT_INSPECTOR_PATH;
    existsSync.mockReturnValue(false);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('returns null when no candidate has index.html', () => {
    expect(resolveUIDistDir()).toBeNull();
  });

  it('returns AGENT_INSPECTOR_PATH when env var is set and dir has index.html', () => {
    const customPath = '/custom/inspector/dist';
    process.env.AGENT_INSPECTOR_PATH = customPath;

    existsSync.mockImplementation(p => p === path.join(customPath, 'index.html'));

    expect(resolveUIDistDir()).toBe(customPath);
  });

  it('skips AGENT_INSPECTOR_PATH when env var is set but dir lacks index.html', () => {
    process.env.AGENT_INSPECTOR_PATH = '/missing/inspector';
    existsSync.mockReturnValue(false);

    expect(resolveUIDistDir()).toBeNull();
  });

  it('returns the first candidate that has index.html', () => {
    existsSync.mockImplementation(p => {
      return String(p).endsWith(path.join('agent-inspector', 'index.html'));
    });

    const result = resolveUIDistDir();
    expect(result).not.toBeNull();
    expect(result!).toMatch(/agent-inspector$/);
  });

  it('prefers AGENT_INSPECTOR_PATH over bundled candidates', () => {
    const customPath = '/custom/path';
    process.env.AGENT_INSPECTOR_PATH = customPath;

    existsSync.mockReturnValue(true);

    expect(resolveUIDistDir()).toBe(customPath);
  });
});
