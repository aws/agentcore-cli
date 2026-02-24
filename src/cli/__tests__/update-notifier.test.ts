import { type UpdateCheckResult, checkForUpdate, printUpdateNotification } from '../update-notifier.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockReadFile, mockWriteFile, mockMkdir } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockWriteFile: vi.fn(),
  mockMkdir: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  mkdir: mockMkdir,
}));

vi.mock('../constants.js', () => ({
  PACKAGE_VERSION: '1.0.0',
}));

const { mockFetchLatestVersion, mockCompareVersions } = vi.hoisted(() => ({
  mockFetchLatestVersion: vi.fn(),
  mockCompareVersions: vi.fn(),
}));

vi.mock('../commands/update/action.js', () => ({
  fetchLatestVersion: mockFetchLatestVersion,
  compareVersions: mockCompareVersions,
}));

describe('checkForUpdate', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(1708646400000);
    mockWriteFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mockReadFile.mockReset();
    mockWriteFile.mockReset();
    mockMkdir.mockReset();
    mockFetchLatestVersion.mockReset();
    mockCompareVersions.mockReset();
  });

  it('fetches from registry when no cache exists', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));
    mockFetchLatestVersion.mockResolvedValue('2.0.0');
    mockCompareVersions.mockReturnValue(1);

    const result = await checkForUpdate();

    expect(result).toEqual({ updateAvailable: true, latestVersion: '2.0.0' });
    expect(mockFetchLatestVersion).toHaveBeenCalled();
  });

  it('uses cache when last check was less than 24 hours ago', async () => {
    const cache = JSON.stringify({
      lastCheck: 1708646400000 - 1000, // 1 second ago
      latestVersion: '2.0.0',
    });
    mockReadFile.mockResolvedValue(cache);
    mockCompareVersions.mockReturnValue(1);

    const result = await checkForUpdate();

    expect(result).toEqual({ updateAvailable: true, latestVersion: '2.0.0' });
    expect(mockFetchLatestVersion).not.toHaveBeenCalled();
  });

  it('fetches from registry when cache is expired', async () => {
    const cache = JSON.stringify({
      lastCheck: 1708646400000 - 25 * 60 * 60 * 1000, // 25 hours ago
      latestVersion: '1.5.0',
    });
    mockReadFile.mockResolvedValue(cache);
    mockFetchLatestVersion.mockResolvedValue('2.0.0');
    mockCompareVersions.mockReturnValue(1);

    const result = await checkForUpdate();

    expect(result).toEqual({ updateAvailable: true, latestVersion: '2.0.0' });
    expect(mockFetchLatestVersion).toHaveBeenCalled();
  });

  it('writes cache after fetching', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));
    mockFetchLatestVersion.mockResolvedValue('2.0.0');
    mockCompareVersions.mockReturnValue(1);

    await checkForUpdate();

    expect(mockMkdir).toHaveBeenCalled();
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining('update-check.json'),
      JSON.stringify({ lastCheck: 1708646400000, latestVersion: '2.0.0' }),
      'utf-8'
    );
  });

  it('returns updateAvailable: false when versions match', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));
    mockFetchLatestVersion.mockResolvedValue('1.0.0');
    mockCompareVersions.mockReturnValue(0);

    const result = await checkForUpdate();

    expect(result).toEqual({ updateAvailable: false, latestVersion: '1.0.0' });
  });

  it('returns updateAvailable: false when current is newer', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));
    mockFetchLatestVersion.mockResolvedValue('0.9.0');
    mockCompareVersions.mockReturnValue(-1);

    const result = await checkForUpdate();

    expect(result).toEqual({ updateAvailable: false, latestVersion: '0.9.0' });
  });

  it('returns null on fetch error', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));
    mockFetchLatestVersion.mockRejectedValue(new Error('network error'));

    const result = await checkForUpdate();

    expect(result).toBeNull();
  });

  it('returns null on cache parse error and fetch error', async () => {
    mockReadFile.mockResolvedValue('invalid json');
    mockFetchLatestVersion.mockRejectedValue(new Error('network error'));

    const result = await checkForUpdate();

    expect(result).toBeNull();
  });

  it('succeeds even when cache write fails', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));
    mockFetchLatestVersion.mockResolvedValue('2.0.0');
    mockCompareVersions.mockReturnValue(1);
    mockWriteFile.mockRejectedValue(new Error('EACCES'));

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
    expect(output).toContain('1.0.0');
    expect(output).toContain('2.0.0');
    expect(output).toContain('npm install -g @aws/agentcore@latest');

    stderrSpy.mockRestore();
  });
});
