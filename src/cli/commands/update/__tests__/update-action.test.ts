import { compareVersions, fetchLatestVersion, handleUpdate } from '../action.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockRunSubprocess } = vi.hoisted(() => ({
  mockRunSubprocess: vi.fn(),
}));

vi.mock('../../../../lib/utils/subprocess', () => ({
  runSubprocess: mockRunSubprocess,
}));

vi.mock('../../../constants.js', () => ({
  PACKAGE_VERSION: '1.2.3',
  getDistroConfig: () => ({
    packageName: '@aws/agentcore',
    registryUrl: 'https://registry.npmjs.org',
    installCommand: 'npm install -g @aws/agentcore@latest',
  }),
}));

describe('compareVersions', () => {
  it('returns 0 for equal versions', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('returns 1 when latest is newer by major', () => {
    expect(compareVersions('1.0.0', '2.0.0')).toBe(1);
  });

  it('returns 1 when latest is newer by minor', () => {
    expect(compareVersions('1.2.0', '1.3.0')).toBe(1);
  });

  it('returns 1 when latest is newer by patch', () => {
    expect(compareVersions('1.2.3', '1.2.4')).toBe(1);
  });

  it('returns -1 when current is newer by major', () => {
    expect(compareVersions('2.0.0', '1.0.0')).toBe(-1);
  });

  it('returns -1 when current is newer by minor', () => {
    expect(compareVersions('1.5.0', '1.3.0')).toBe(-1);
  });

  it('returns -1 when current is newer by patch', () => {
    expect(compareVersions('1.2.5', '1.2.3')).toBe(-1);
  });

  it('handles versions with missing parts', () => {
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
  });

  it('returns 1 when latest pre-release is newer', () => {
    expect(compareVersions('0.3.0-preview.1.0', '0.3.0-preview.2.0')).toBe(1);
  });

  it('returns -1 when current pre-release is newer', () => {
    expect(compareVersions('0.3.0-preview.2.0', '0.3.0-preview.1.0')).toBe(-1);
  });

  it('returns 0 for equal pre-release versions', () => {
    expect(compareVersions('0.3.0-preview.1.0', '0.3.0-preview.1.0')).toBe(0);
  });

  it('returns 1 when latest is release and current is pre-release', () => {
    expect(compareVersions('1.0.0-preview.1', '1.0.0')).toBe(1);
  });

  it('returns -1 when current is release and latest is pre-release', () => {
    expect(compareVersions('1.0.0', '1.0.0-preview.1')).toBe(-1);
  });

  it('compares pre-release labels lexicographically', () => {
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-beta.1')).toBe(1);
  });
});

describe('fetchLatestVersion', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns version from registry', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ version: '2.0.0' }),
    } as Response);

    const version = await fetchLatestVersion();

    expect(version).toBe('2.0.0');
    expect(fetch).toHaveBeenCalledWith('https://registry.npmjs.org/@aws/agentcore/latest');
  });

  it('throws when response is not ok', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      statusText: 'Not Found',
    } as Response);

    await expect(fetchLatestVersion()).rejects.toThrow('Failed to fetch latest version: Not Found');
  });
});

describe('handleUpdate', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mockRunSubprocess.mockReset();
  });

  it('returns up-to-date when versions match', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ version: '1.2.3' }),
    } as Response);

    const result = await handleUpdate(false);

    expect(result.status).toBe('up-to-date');
    expect(result.currentVersion).toBe('1.2.3');
    expect(result.latestVersion).toBe('1.2.3');
  });

  it('returns newer-local when current is ahead', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ version: '1.0.0' }),
    } as Response);

    const result = await handleUpdate(false);

    expect(result.status).toBe('newer-local');
  });

  it('returns update-available when checkOnly is true', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ version: '2.0.0' }),
    } as Response);

    const result = await handleUpdate(true);

    expect(result.status).toBe('update-available');
    expect(mockRunSubprocess).not.toHaveBeenCalled();
  });

  it('returns updated after successful install', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ version: '2.0.0' }),
    } as Response);
    mockRunSubprocess.mockResolvedValue(undefined);

    const result = await handleUpdate(false);

    expect(result.status).toBe('updated');
    expect(mockRunSubprocess).toHaveBeenCalledWith('npm', ['install', '-g', '@aws/agentcore@latest'], {
      stdio: 'inherit',
    });
  });

  it('returns update-failed when install throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ version: '2.0.0' }),
    } as Response);
    mockRunSubprocess.mockRejectedValue(new Error('install failed'));

    const result = await handleUpdate(false);

    expect(result.status).toBe('update-failed');
  });
});
