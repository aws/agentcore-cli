import { PythonCodeZipPackager, PythonCodeZipPackagerSync } from '../python.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockRunSubprocessCapture = vi.fn();
const mockRunSubprocessCaptureSync = vi.fn();
const mockResolveProjectPaths = vi.fn();
const mockResolveProjectPathsSync = vi.fn();
const mockEnsureBinaryAvailable = vi.fn();
const mockEnsureBinaryAvailableSync = vi.fn();
const mockEnsureDirClean = vi.fn();
const mockEnsureDirCleanSync = vi.fn();
const mockCopySourceTree = vi.fn();
const mockCopySourceTreeSync = vi.fn();
const mockCreateZipFromDir = vi.fn();
const mockCreateZipFromDirSync = vi.fn();
const mockEnforceZipSizeLimit = vi.fn();
const mockEnforceZipSizeLimitSync = vi.fn();
const mockConvertWindowsScriptsToLinux = vi.fn();
const mockConvertWindowsScriptsToLinuxSync = vi.fn();

vi.mock('../../utils/subprocess', () => ({
  runSubprocessCapture: (...args: unknown[]) => mockRunSubprocessCapture(...args),
  runSubprocessCaptureSync: (...args: unknown[]) => mockRunSubprocessCaptureSync(...args),
}));

vi.mock('../helpers', () => ({
  resolveProjectPaths: (...args: unknown[]) => mockResolveProjectPaths(...args),
  resolveProjectPathsSync: (...args: unknown[]) => mockResolveProjectPathsSync(...args),
  ensureBinaryAvailable: (...args: unknown[]) => mockEnsureBinaryAvailable(...args),
  ensureBinaryAvailableSync: (...args: unknown[]) => mockEnsureBinaryAvailableSync(...args),
  ensureDirClean: (...args: unknown[]) => mockEnsureDirClean(...args),
  ensureDirCleanSync: (...args: unknown[]) => mockEnsureDirCleanSync(...args),
  copySourceTree: (...args: unknown[]) => mockCopySourceTree(...args),
  copySourceTreeSync: (...args: unknown[]) => mockCopySourceTreeSync(...args),
  createZipFromDir: (...args: unknown[]) => mockCreateZipFromDir(...args),
  createZipFromDirSync: (...args: unknown[]) => mockCreateZipFromDirSync(...args),
  enforceZipSizeLimit: (...args: unknown[]) => mockEnforceZipSizeLimit(...args),
  enforceZipSizeLimitSync: (...args: unknown[]) => mockEnforceZipSizeLimitSync(...args),
  convertWindowsScriptsToLinux: (...args: unknown[]) => mockConvertWindowsScriptsToLinux(...args),
  convertWindowsScriptsToLinuxSync: (...args: unknown[]) => mockConvertWindowsScriptsToLinuxSync(...args),
  isPythonRuntime: (v: string) => v.startsWith('PYTHON_'),
}));

const defaultPaths = {
  projectRoot: '/project',
  srcDir: '/project/src',
  stagingDir: '/project/.staging',
  artifactsDir: '/project/artifacts',
  pyprojectPath: '/project/pyproject.toml',
};

describe('PythonCodeZipPackager', () => {
  afterEach(() => vi.resetAllMocks());

  const packager = new PythonCodeZipPackager();

  it.each([
    'have no usable wheels',
    'have no wheels with a matching Python ABI tag',
    'have no wheels with a matching platform tag',
  ])('retries the next platform for plural uv errors: %s', async message => {
    mockResolveProjectPaths.mockResolvedValue(defaultPaths);
    mockRunSubprocessCapture
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: `numpy>=2.4.0 ${message}`, signal: null })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '', signal: null });
    mockEnforceZipSizeLimit.mockResolvedValue(2048);

    const result = await packager.pack({ build: 'CodeZip', runtimeVersion: 'PYTHON_3_14', name: 'agent' } as any);

    expect(result.sizeBytes).toBe(2048);
    expect(mockRunSubprocessCapture).toHaveBeenCalledTimes(2);
    expect(mockRunSubprocessCapture.mock.calls.map(call => call[1][call[1].indexOf('--python-platform') + 1])).toEqual([
      'aarch64-manylinux2014',
      'aarch64-manylinux_2_28',
    ]);
    expect(mockCopySourceTree).toHaveBeenCalledTimes(1);
  });

  it('throws for non-CodeZip build type', async () => {
    await expect(packager.pack({ build: 'Docker', runtimeVersion: 'PYTHON_3_12', name: 'a' } as any)).rejects.toThrow(
      'only supports CodeZip'
    );
  });

  it('throws for non-Python runtime', async () => {
    await expect(packager.pack({ build: 'CodeZip', runtimeVersion: 'NODE_20', name: 'a' } as any)).rejects.toThrow(
      'only supports Python runtimes'
    );
  });

  it('packs successfully on first platform', async () => {
    mockResolveProjectPaths.mockResolvedValue(defaultPaths);
    mockEnsureBinaryAvailable.mockResolvedValue(undefined);
    mockEnsureDirClean.mockResolvedValue(undefined);
    mockRunSubprocessCapture.mockResolvedValue({ code: 0, stdout: '', stderr: '', signal: null });
    mockCopySourceTree.mockResolvedValue(undefined);
    mockConvertWindowsScriptsToLinux.mockResolvedValue(undefined);
    mockCreateZipFromDir.mockResolvedValue(undefined);
    mockEnforceZipSizeLimit.mockResolvedValue(4096);

    const result = await packager.pack({ build: 'CodeZip', runtimeVersion: 'PYTHON_3_12', name: 'agent' } as any);

    expect(result.sizeBytes).toBe(4096);
    expect(mockRunSubprocessCapture).toHaveBeenCalledWith(
      'uv',
      expect.arrayContaining(['pip', 'install']),
      expect.any(Object)
    );
  });

  it('retries on platform issue and succeeds', async () => {
    mockResolveProjectPaths.mockResolvedValue(defaultPaths);
    mockEnsureBinaryAvailable.mockResolvedValue(undefined);
    mockEnsureDirClean.mockResolvedValue(undefined);
    // First platform fails with platform issue, second succeeds
    mockRunSubprocessCapture
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'has no usable wheels', signal: null })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '', signal: null });
    mockCopySourceTree.mockResolvedValue(undefined);
    mockConvertWindowsScriptsToLinux.mockResolvedValue(undefined);
    mockCreateZipFromDir.mockResolvedValue(undefined);
    mockEnforceZipSizeLimit.mockResolvedValue(2048);

    const result = await packager.pack({ build: 'CodeZip', runtimeVersion: 'PYTHON_3_12', name: 'agent' } as any);

    expect(result.sizeBytes).toBe(2048);
    expect(mockRunSubprocessCapture).toHaveBeenCalledTimes(2);
  });

  it('throws on non-platform error', async () => {
    mockResolveProjectPaths.mockResolvedValue(defaultPaths);
    mockEnsureBinaryAvailable.mockResolvedValue(undefined);
    mockEnsureDirClean.mockResolvedValue(undefined);
    mockRunSubprocessCapture.mockResolvedValue({ code: 1, stdout: '', stderr: 'fatal error', signal: null });

    await expect(packager.pack({ build: 'CodeZip', runtimeVersion: 'PYTHON_3_12', name: 'a' } as any)).rejects.toThrow(
      'fatal error'
    );
  });

  it('throws when all platforms fail', async () => {
    mockResolveProjectPaths.mockResolvedValue(defaultPaths);
    mockEnsureBinaryAvailable.mockResolvedValue(undefined);
    mockEnsureDirClean.mockResolvedValue(undefined);
    mockRunSubprocessCapture.mockResolvedValue({ code: 1, stdout: '', stderr: 'has no usable wheels', signal: null });

    await expect(packager.pack({ build: 'CodeZip', runtimeVersion: 'PYTHON_3_12', name: 'a' } as any)).rejects.toThrow(
      'all platform candidates'
    );
  });
});

describe('PythonCodeZipPackagerSync', () => {
  afterEach(() => vi.resetAllMocks());

  const packager = new PythonCodeZipPackagerSync();

  it.each([
    'have no usable wheels',
    'have no wheels with a matching Python ABI tag',
    'have no wheels with a matching platform tag',
  ])('retries the next platform for plural uv errors: %s', message => {
    mockResolveProjectPathsSync.mockReturnValue(defaultPaths);
    mockRunSubprocessCaptureSync
      .mockReturnValueOnce({ code: 1, stdout: '', stderr: `numpy>=2.4.0 ${message}`, signal: null })
      .mockReturnValueOnce({ code: 0, stdout: '', stderr: '', signal: null });
    mockEnforceZipSizeLimitSync.mockReturnValue(2048);

    const result = packager.packCodeZip({ build: 'CodeZip', runtimeVersion: 'PYTHON_3_14', name: 'agent' } as any);

    expect(result.sizeBytes).toBe(2048);
    expect(mockRunSubprocessCaptureSync).toHaveBeenCalledTimes(2);
    expect(
      mockRunSubprocessCaptureSync.mock.calls.map(call => call[1][call[1].indexOf('--python-platform') + 1])
    ).toEqual(['aarch64-manylinux2014', 'aarch64-manylinux_2_28']);
    expect(mockCopySourceTreeSync).toHaveBeenCalledTimes(1);
  });

  it('throws for non-Python runtime', () => {
    expect(() => packager.packCodeZip({ build: 'CodeZip', runtimeVersion: 'NODE_20', name: 'a' } as any)).toThrow(
      'only supports Python runtimes'
    );
  });

  it('packs successfully', () => {
    mockResolveProjectPathsSync.mockReturnValue(defaultPaths);
    mockEnsureBinaryAvailableSync.mockReturnValue(undefined);
    mockEnsureDirCleanSync.mockReturnValue(undefined);
    mockRunSubprocessCaptureSync.mockReturnValue({ code: 0, stdout: '', stderr: '', signal: null });
    mockCopySourceTreeSync.mockReturnValue(undefined);
    mockConvertWindowsScriptsToLinuxSync.mockReturnValue(undefined);
    mockCreateZipFromDirSync.mockReturnValue(undefined);
    mockEnforceZipSizeLimitSync.mockReturnValue(3072);

    const result = packager.packCodeZip({ build: 'CodeZip', runtimeVersion: 'PYTHON_3_12', name: 'agent' } as any);

    expect(result.sizeBytes).toBe(3072);
  });

  it('throws when install fails with non-platform error', () => {
    mockResolveProjectPathsSync.mockReturnValue(defaultPaths);
    mockEnsureBinaryAvailableSync.mockReturnValue(undefined);
    mockEnsureDirCleanSync.mockReturnValue(undefined);
    mockRunSubprocessCaptureSync.mockReturnValue({ code: 1, stdout: '', stderr: 'sync fail', signal: null });

    expect(() => packager.packCodeZip({ build: 'CodeZip', runtimeVersion: 'PYTHON_3_12', name: 'a' } as any)).toThrow(
      'sync fail'
    );
  });
});
