import { type UpdateCheckResult, checkForUpdate, printUpdateNotification } from '../update-notifier.js';
import { rmSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tmpDir = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  /* eslint-enable @typescript-eslint/no-require-imports */
  return fs.mkdtempSync(path.join(os.tmpdir(), 'update-notifier-test-'));
});

vi.mock('../../lib/schemas/io/global-config.js', () => ({
  GLOBAL_CONFIG_DIR: tmpDir,
}));

vi.mock('../constants.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../constants.js')>();
  return { ...actual, PACKAGE_VERSION: '1.0.0' };
});

const { mockFetchLatestVersion } = vi.hoisted(() => ({
  mockFetchLatestVersion: vi.fn(),
}));

vi.mock('../commands/update/action.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../commands/update/action.js')>();
  return { ...actual, fetchLatestVersion: mockFetchLatestVersion };
});

const CACHE_DIR = tmpDir;
const CACHE_FILE = join(tmpDir, 'update-check.json');

describe('checkForUpdate', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(1708646400000);
    try {
      rmSync(CACHE_DIR, { recursive: true });
    } catch {}
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mockFetchLatestVersion.mockReset();
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true });
  });

  it('fetches from registry when no cache exists', async () => {
    mockFetchLatestVersion.mockResolvedValue('2.0.0');

    const result = await checkForUpdate();

    expect(result).toEqual({ updateAvailable: true, latestVersion: '2.0.0' });
    expect(mockFetchLatestVersion).toHaveBeenCalled();
  });

  it('uses cache when last check was less than 24 hours ago', async () => {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(CACHE_FILE, JSON.stringify({ lastCheck: 1708646400000 - 1000, latestVersion: '2.0.0' }), 'utf-8');

    const result = await checkForUpdate();

    expect(result).toEqual({ updateAvailable: true, latestVersion: '2.0.0' });
    expect(mockFetchLatestVersion).not.toHaveBeenCalled();
  });

  it('fetches from registry when cache is expired', async () => {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(
      CACHE_FILE,
      JSON.stringify({ lastCheck: 1708646400000 - 25 * 60 * 60 * 1000, latestVersion: '1.5.0' }),
      'utf-8'
    );
    mockFetchLatestVersion.mockResolvedValue('2.0.0');

    const result = await checkForUpdate();

    expect(result).toEqual({ updateAvailable: true, latestVersion: '2.0.0' });
    expect(mockFetchLatestVersion).toHaveBeenCalled();
  });

  it('writes cache after fetching', async () => {
    mockFetchLatestVersion.mockResolvedValue('2.0.0');

    await checkForUpdate();

    const cached = JSON.parse(await readFile(CACHE_FILE, 'utf-8'));
    expect(cached).toEqual({ lastCheck: 1708646400000, latestVersion: '2.0.0' });
  });

  it('returns updateAvailable: false when versions match', async () => {
    mockFetchLatestVersion.mockResolvedValue('1.0.0');

    const result = await checkForUpdate();

    expect(result).toEqual({ updateAvailable: false, latestVersion: '1.0.0' });
  });

  it('returns updateAvailable: false when current is newer', async () => {
    mockFetchLatestVersion.mockResolvedValue('0.9.0');

    const result = await checkForUpdate();

    expect(result).toEqual({ updateAvailable: false, latestVersion: '0.9.0' });
  });

  it('returns null on fetch error', async () => {
    mockFetchLatestVersion.mockRejectedValue(new Error('network error'));

    const result = await checkForUpdate();

    expect(result).toBeNull();
  });

  it('returns null on cache parse error and fetch error', async () => {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(CACHE_FILE, 'invalid json', 'utf-8');
    mockFetchLatestVersion.mockRejectedValue(new Error('network error'));

    const result = await checkForUpdate();

    expect(result).toBeNull();
  });

  it('succeeds even when cache write fails', async () => {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(CACHE_FILE, '', 'utf-8');
    const { chmod } = await import('fs/promises');
    await chmod(CACHE_DIR, 0o444);

    mockFetchLatestVersion.mockResolvedValue('2.0.0');

    const result = await checkForUpdate();

    expect(result).toEqual({ updateAvailable: true, latestVersion: '2.0.0' });

    await chmod(CACHE_DIR, 0o755);
  });
});

describe('printUpdateNotification', () => {
  it('writes notification to stderr', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const result: UpdateCheckResult = { updateAvailable: true, latestVersion: '2.0.0' };
    printUpdateNotification(result);

    const output = stderrSpy.mock.calls.map(c => c[0]).join('');
    expect(output).toContain('Update available:');
    expect(output).toContain('1.0.0');
    expect(output).toContain('2.0.0');
    expect(output).toContain('npm install -g @aws/agentcore@latest');

    stderrSpy.mockRestore();
  });
});
