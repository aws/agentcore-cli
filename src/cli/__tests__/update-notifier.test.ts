import { ONE_DAY_MS, ONE_HOUR_MS, ONE_SECOND_MS } from '../../lib/time-constants.js';
import * as action from '../commands/update/action.js';
import * as constants from '../constants.js';
import { type UpdateCheckResult, checkForUpdate, printUpdateNotification } from '../update-notifier.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const NOW = 1708646400000;
const tmpDir = mkdtempSync(join(tmpdir(), 'update-notifier-test-'));
const CACHE_FILE = join(tmpDir, 'update-check.json');

describe('checkForUpdate', () => {
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    originalConfigDir = process.env.AGENTCORE_CONFIG_DIR;
    process.env.AGENTCORE_CONFIG_DIR = tmpDir;
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    vi.spyOn(constants, 'PACKAGE_VERSION', 'get').mockReturnValue('1.0.0');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalConfigDir === undefined) {
      delete process.env.AGENTCORE_CONFIG_DIR;
    } else {
      process.env.AGENTCORE_CONFIG_DIR = originalConfigDir;
    }
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fetches from registry when no cache exists', async () => {
    vi.spyOn(action, 'fetchLatestVersion').mockResolvedValue('2.0.0');

    const result = await checkForUpdate();

    expect(result).toEqual({ updateAvailable: true, latestVersion: '2.0.0' });
  });

  it('uses cache when last check was less than 24 hours ago', async () => {
    await mkdir(tmpDir, { recursive: true });
    await writeFile(CACHE_FILE, JSON.stringify({ lastCheck: NOW - ONE_SECOND_MS, latestVersion: '2.0.0' }), 'utf-8');

    const result = await checkForUpdate();

    expect(result).toEqual({ updateAvailable: true, latestVersion: '2.0.0' });
  });

  it('fetches from registry when cache is expired', async () => {
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      CACHE_FILE,
      JSON.stringify({ lastCheck: NOW - ONE_DAY_MS - ONE_HOUR_MS, latestVersion: '1.5.0' }),
      'utf-8'
    );
    vi.spyOn(action, 'fetchLatestVersion').mockResolvedValue('2.0.0');

    const result = await checkForUpdate();

    expect(result).toEqual({ updateAvailable: true, latestVersion: '2.0.0' });
  });

  it('writes cache after fetching', async () => {
    vi.spyOn(action, 'fetchLatestVersion').mockResolvedValue('2.0.0');

    await checkForUpdate();

    const cached = JSON.parse(await readFile(CACHE_FILE, 'utf-8'));
    expect(cached).toEqual({ lastCheck: NOW, latestVersion: '2.0.0' });
  });

  it('returns updateAvailable: false when versions match', async () => {
    vi.spyOn(action, 'fetchLatestVersion').mockResolvedValue('1.0.0');

    const result = await checkForUpdate();

    expect(result).toEqual({ updateAvailable: false, latestVersion: '1.0.0' });
  });

  it('returns updateAvailable: false when current is newer', async () => {
    vi.spyOn(action, 'fetchLatestVersion').mockResolvedValue('0.9.0');

    const result = await checkForUpdate();

    expect(result).toEqual({ updateAvailable: false, latestVersion: '0.9.0' });
  });

  it('returns null on fetch error', async () => {
    vi.spyOn(action, 'fetchLatestVersion').mockRejectedValue(new Error('network error'));

    const result = await checkForUpdate();

    expect(result).toBeNull();
  });

  it('returns null on cache parse error and fetch error', async () => {
    await mkdir(tmpDir, { recursive: true });
    await writeFile(CACHE_FILE, 'invalid json', 'utf-8');
    vi.spyOn(action, 'fetchLatestVersion').mockRejectedValue(new Error('network error'));

    const result = await checkForUpdate();

    expect(result).toBeNull();
  });

  it('succeeds even when cache write fails', async () => {
    // Point config dir at a regular file — mkdir/writeFile will fail because
    // a file can't be used as a directory. Works cross-platform and as root.
    mkdirSync(tmpDir, { recursive: true });
    const blocker = join(tmpDir, 'not-a-dir');
    writeFileSync(blocker, '');
    process.env.AGENTCORE_CONFIG_DIR = blocker;

    vi.spyOn(action, 'fetchLatestVersion').mockResolvedValue('2.0.0');

    const result = await checkForUpdate();

    expect(result).toEqual({ updateAvailable: true, latestVersion: '2.0.0' });
  });
});

describe('printUpdateNotification', () => {
  it('writes notification to stderr', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const result: UpdateCheckResult = { updateAvailable: true, latestVersion: '2.0.0' };
    printUpdateNotification(result);

    const output = stderrSpy.mock.calls.map(c => c[0]).join('');
    expect(output).toContain('Update available:');
    expect(output).toContain('2.0.0');
    expect(output).toContain('npm install -g @aws/agentcore@latest');

    stderrSpy.mockRestore();
  });
});
