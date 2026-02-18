import { detectContainerRuntime, getStartHint, requireContainerRuntime } from '../detect.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockCheckSubprocess, mockRunSubprocessCapture } = vi.hoisted(() => ({
  mockCheckSubprocess: vi.fn(),
  mockRunSubprocessCapture: vi.fn(),
}));

vi.mock('../../../lib', () => ({
  CONTAINER_RUNTIMES: ['docker', 'podman', 'finch'],
  START_HINTS: {
    docker: 'Start Docker Desktop or run: sudo systemctl start docker',
    podman: 'Run: podman machine start',
    finch: 'Run: finch vm init && finch vm start',
  },
  checkSubprocess: mockCheckSubprocess,
  runSubprocessCapture: mockRunSubprocessCapture,
  isWindows: false,
}));

afterEach(() => vi.clearAllMocks());

describe('getStartHint', () => {
  it('formats a single runtime hint', () => {
    const result = getStartHint(['docker']);
    expect(result).toBe('  docker: Start Docker Desktop or run: sudo systemctl start docker');
  });

  it('joins multiple runtime hints with newlines', () => {
    const result = getStartHint(['docker', 'finch']);
    expect(result).toBe(
      '  docker: Start Docker Desktop or run: sudo systemctl start docker\n' +
        '  finch: Run: finch vm init && finch vm start'
    );
  });

  it('returns empty string for empty array', () => {
    const result = getStartHint([]);
    expect(result).toBe('');
  });
});

describe('detectContainerRuntime', () => {
  it('returns docker when docker is installed and ready', async () => {
    mockCheckSubprocess.mockResolvedValue(true);
    mockRunSubprocessCapture.mockImplementation((_bin: string, args: string[]) => {
      if (args[0] === '--version') return Promise.resolve({ code: 0, stdout: 'Docker version 24.0.0\n', stderr: '' });
      if (args[0] === 'info') return Promise.resolve({ code: 0, stdout: '', stderr: '' });
      return Promise.resolve({ code: 1, stdout: '', stderr: '' });
    });

    const result = await detectContainerRuntime();
    expect(result.runtime).toEqual({ runtime: 'docker', binary: 'docker', version: 'Docker version 24.0.0' });
    expect(result.notReadyRuntimes).toEqual([]);
  });

  it('falls back to podman when docker not installed', async () => {
    mockCheckSubprocess.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'docker') return Promise.resolve(false);
      if (args[0] === 'podman') return Promise.resolve(true);
      return Promise.resolve(false);
    });
    mockRunSubprocessCapture.mockImplementation((bin: string, args: string[]) => {
      if (bin === 'podman' && args[0] === '--version')
        return Promise.resolve({ code: 0, stdout: 'podman version 4.5.0\n', stderr: '' });
      if (bin === 'podman' && args[0] === 'info') return Promise.resolve({ code: 0, stdout: '', stderr: '' });
      return Promise.resolve({ code: 1, stdout: '', stderr: '' });
    });

    const result = await detectContainerRuntime();
    expect(result.runtime).toEqual({ runtime: 'podman', binary: 'podman', version: 'podman version 4.5.0' });
  });

  it('reports docker as notReady when installed but daemon not running', async () => {
    // docker exists and --version works, but info fails
    mockCheckSubprocess.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'docker') return Promise.resolve(true);
      return Promise.resolve(false);
    });
    mockRunSubprocessCapture.mockImplementation((bin: string, args: string[]) => {
      if (bin === 'docker' && args[0] === '--version')
        return Promise.resolve({ code: 0, stdout: 'Docker version 24.0.0\n', stderr: '' });
      if (bin === 'docker' && args[0] === 'info')
        return Promise.resolve({ code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' });
      return Promise.resolve({ code: 1, stdout: '', stderr: '' });
    });

    const result = await detectContainerRuntime();
    expect(result.runtime).toBeNull();
    expect(result.notReadyRuntimes).toContain('docker');
  });

  it('returns null runtime when nothing is installed', async () => {
    mockCheckSubprocess.mockResolvedValue(false);

    const result = await detectContainerRuntime();
    expect(result.runtime).toBeNull();
    expect(result.notReadyRuntimes).toEqual([]);
  });

  it('returns null with notReadyRuntimes when installed but not ready', async () => {
    mockCheckSubprocess.mockResolvedValue(true);
    mockRunSubprocessCapture.mockImplementation((_bin: string, args: string[]) => {
      if (args[0] === '--version') return Promise.resolve({ code: 0, stdout: 'v1.0.0\n', stderr: '' });
      if (args[0] === 'info') return Promise.resolve({ code: 1, stdout: '', stderr: 'not running' });
      return Promise.resolve({ code: 1, stdout: '', stderr: '' });
    });

    const result = await detectContainerRuntime();
    expect(result.runtime).toBeNull();
    expect(result.notReadyRuntimes).toEqual(['docker', 'podman', 'finch']);
  });

  it('skips runtime when --version check fails', async () => {
    mockCheckSubprocess.mockResolvedValue(true);
    mockRunSubprocessCapture.mockImplementation((bin: string, args: string[]) => {
      // docker --version fails, podman works
      if (bin === 'docker' && args[0] === '--version') return Promise.resolve({ code: 1, stdout: '', stderr: 'error' });
      if (bin === 'podman' && args[0] === '--version')
        return Promise.resolve({ code: 0, stdout: 'podman version 4.5.0\n', stderr: '' });
      if (bin === 'podman' && args[0] === 'info') return Promise.resolve({ code: 0, stdout: '', stderr: '' });
      // finch --version also fails
      if (bin === 'finch' && args[0] === '--version') return Promise.resolve({ code: 1, stdout: '', stderr: 'error' });
      return Promise.resolve({ code: 1, stdout: '', stderr: '' });
    });

    const result = await detectContainerRuntime();
    expect(result.runtime).toEqual({ runtime: 'podman', binary: 'podman', version: 'podman version 4.5.0' });
    expect(result.notReadyRuntimes).toEqual([]);
  });

  it('extracts first line of --version output as version string', async () => {
    mockCheckSubprocess.mockResolvedValue(true);
    mockRunSubprocessCapture.mockImplementation((_bin: string, args: string[]) => {
      if (args[0] === '--version')
        return Promise.resolve({ code: 0, stdout: 'Docker version 24.0.0\nExtra info line\n', stderr: '' });
      if (args[0] === 'info') return Promise.resolve({ code: 0, stdout: '', stderr: '' });
      return Promise.resolve({ code: 1, stdout: '', stderr: '' });
    });

    const result = await detectContainerRuntime();
    expect(result.runtime?.version).toBe('Docker version 24.0.0');
  });

  it('uses empty first line when version output is empty', async () => {
    mockCheckSubprocess.mockResolvedValue(true);
    mockRunSubprocessCapture.mockImplementation((_bin: string, args: string[]) => {
      if (args[0] === '--version') return Promise.resolve({ code: 0, stdout: '', stderr: '' });
      if (args[0] === 'info') return Promise.resolve({ code: 0, stdout: '', stderr: '' });
      return Promise.resolve({ code: 1, stdout: '', stderr: '' });
    });

    const result = await detectContainerRuntime();
    // ''.trim().split('\n')[0] returns '' (not undefined), so ?? 'unknown' doesn't trigger
    expect(result.runtime?.version).toBe('');
  });
});

describe('requireContainerRuntime', () => {
  it('returns runtime info when available', async () => {
    mockCheckSubprocess.mockResolvedValue(true);
    mockRunSubprocessCapture.mockImplementation((_bin: string, args: string[]) => {
      if (args[0] === '--version') return Promise.resolve({ code: 0, stdout: 'Docker version 24.0.0\n', stderr: '' });
      if (args[0] === 'info') return Promise.resolve({ code: 0, stdout: '', stderr: '' });
      return Promise.resolve({ code: 1, stdout: '', stderr: '' });
    });

    const result = await requireContainerRuntime();
    expect(result).toEqual({ runtime: 'docker', binary: 'docker', version: 'Docker version 24.0.0' });
  });

  it('throws with install links when no runtime found and none notReady', async () => {
    mockCheckSubprocess.mockResolvedValue(false);

    await expect(requireContainerRuntime()).rejects.toThrow('No container runtime found');
    await expect(requireContainerRuntime()).rejects.toThrow('https://docker.com');
  });

  it('throws with start hints when runtimes installed but not ready', async () => {
    mockCheckSubprocess.mockResolvedValue(true);
    mockRunSubprocessCapture.mockImplementation((_bin: string, args: string[]) => {
      if (args[0] === '--version') return Promise.resolve({ code: 0, stdout: 'v1.0.0\n', stderr: '' });
      if (args[0] === 'info') return Promise.resolve({ code: 1, stdout: '', stderr: 'not running' });
      return Promise.resolve({ code: 1, stdout: '', stderr: '' });
    });

    await expect(requireContainerRuntime()).rejects.toThrow('not ready');
    await expect(requireContainerRuntime()).rejects.toThrow('Start a runtime');
  });
});
