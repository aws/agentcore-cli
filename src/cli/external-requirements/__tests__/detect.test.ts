import { detectContainerRuntime, requireContainerRuntime } from '../detect.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockCheckSubprocess, mockRunSubprocessCapture } = vi.hoisted(() => ({
  mockCheckSubprocess: vi.fn(),
  mockRunSubprocessCapture: vi.fn(),
}));

vi.mock('../../../lib', () => ({
  CONTAINER_RUNTIMES: ['docker', 'podman', 'finch'],
  checkSubprocess: mockCheckSubprocess,
  runSubprocessCapture: mockRunSubprocessCapture,
  isWindows: false,
}));

afterEach(() => vi.clearAllMocks());

describe('detectContainerRuntime', () => {
  it('returns docker when docker is installed', async () => {
    mockCheckSubprocess.mockResolvedValue(true);
    mockRunSubprocessCapture.mockImplementation((_bin: string, args: string[]) => {
      if (args[0] === '--version') return Promise.resolve({ code: 0, stdout: 'Docker version 24.0.0\n', stderr: '' });
      return Promise.resolve({ code: 1, stdout: '', stderr: '' });
    });

    const result = await detectContainerRuntime();
    expect(result.runtime).toEqual({ runtime: 'docker', binary: 'docker', version: 'Docker version 24.0.0' });
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
      return Promise.resolve({ code: 1, stdout: '', stderr: '' });
    });

    const result = await detectContainerRuntime();
    expect(result.runtime).toEqual({ runtime: 'podman', binary: 'podman', version: 'podman version 4.5.0' });
  });

  it('returns null runtime when nothing is installed', async () => {
    mockCheckSubprocess.mockResolvedValue(false);

    const result = await detectContainerRuntime();
    expect(result.runtime).toBeNull();
  });

  it('skips runtime when --version check fails', async () => {
    mockCheckSubprocess.mockResolvedValue(true);
    mockRunSubprocessCapture.mockImplementation((bin: string, args: string[]) => {
      // docker --version fails, podman works
      if (bin === 'docker' && args[0] === '--version') return Promise.resolve({ code: 1, stdout: '', stderr: 'error' });
      if (bin === 'podman' && args[0] === '--version')
        return Promise.resolve({ code: 0, stdout: 'podman version 4.5.0\n', stderr: '' });
      // finch --version also fails
      if (bin === 'finch' && args[0] === '--version') return Promise.resolve({ code: 1, stdout: '', stderr: 'error' });
      return Promise.resolve({ code: 1, stdout: '', stderr: '' });
    });

    const result = await detectContainerRuntime();
    expect(result.runtime).toEqual({ runtime: 'podman', binary: 'podman', version: 'podman version 4.5.0' });
  });

  it('extracts first line of --version output as version string', async () => {
    mockCheckSubprocess.mockResolvedValue(true);
    mockRunSubprocessCapture.mockImplementation((_bin: string, args: string[]) => {
      if (args[0] === '--version')
        return Promise.resolve({ code: 0, stdout: 'Docker version 24.0.0\nExtra info line\n', stderr: '' });
      return Promise.resolve({ code: 1, stdout: '', stderr: '' });
    });

    const result = await detectContainerRuntime();
    expect(result.runtime?.version).toBe('Docker version 24.0.0');
  });

  it('uses empty first line when version output is empty', async () => {
    mockCheckSubprocess.mockResolvedValue(true);
    mockRunSubprocessCapture.mockImplementation((_bin: string, args: string[]) => {
      if (args[0] === '--version') return Promise.resolve({ code: 0, stdout: '', stderr: '' });
      return Promise.resolve({ code: 1, stdout: '', stderr: '' });
    });

    const result = await detectContainerRuntime();
    // ''.trim().split('\n')[0] returns '' (not undefined), so ?? 'unknown' doesn't trigger
    expect(result.runtime?.version).toBe('');
  });

  it('does not call docker info to check daemon status', async () => {
    mockCheckSubprocess.mockResolvedValue(true);
    mockRunSubprocessCapture.mockImplementation((_bin: string, args: string[]) => {
      if (args[0] === '--version') return Promise.resolve({ code: 0, stdout: 'Docker version 24.0.0\n', stderr: '' });
      return Promise.resolve({ code: 1, stdout: '', stderr: '' });
    });

    await detectContainerRuntime();

    // Verify 'info' was never called — this is the key behavioral change
    const infoCalls = mockRunSubprocessCapture.mock.calls.filter(
      (call: unknown[]) => (call[1] as string[])[0] === 'info'
    );
    expect(infoCalls).toHaveLength(0);
  });
});

describe('requireContainerRuntime', () => {
  it('returns runtime info when available', async () => {
    mockCheckSubprocess.mockResolvedValue(true);
    mockRunSubprocessCapture.mockImplementation((_bin: string, args: string[]) => {
      if (args[0] === '--version') return Promise.resolve({ code: 0, stdout: 'Docker version 24.0.0\n', stderr: '' });
      return Promise.resolve({ code: 1, stdout: '', stderr: '' });
    });

    const result = await requireContainerRuntime();
    expect(result).toEqual({ runtime: 'docker', binary: 'docker', version: 'Docker version 24.0.0' });
  });

  it('throws with install links when no runtime found', async () => {
    mockCheckSubprocess.mockResolvedValue(false);

    await expect(requireContainerRuntime()).rejects.toThrow('No container runtime found');
    await expect(requireContainerRuntime()).rejects.toThrow('https://docker.com');
  });
});
