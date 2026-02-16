import { NodeCodeZipPackager, NodeCodeZipPackagerSync } from '../node.js';
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
  isNodeRuntime: (v: string) => v.startsWith('NODE_'),
}));

const defaultPaths = {
  projectRoot: '/project',
  srcDir: '/project/src',
  stagingDir: '/project/.staging',
  artifactsDir: '/project/artifacts',
  pyprojectPath: '',
};

describe('NodeCodeZipPackager', () => {
  afterEach(() => vi.clearAllMocks());

  const packager = new NodeCodeZipPackager();

  it('throws for non-CodeZip build type', async () => {
    await expect(packager.pack({ build: 'Docker', runtimeVersion: 'NODE_20', name: 'a' } as any)).rejects.toThrow(
      'only supports CodeZip'
    );
  });

  it('throws for non-Node runtime', async () => {
    await expect(packager.pack({ build: 'CodeZip', runtimeVersion: 'PYTHON_3_12', name: 'a' } as any)).rejects.toThrow(
      'only supports Node runtimes'
    );
  });

  it('packs successfully', async () => {
    mockResolveProjectPaths.mockResolvedValue(defaultPaths);
    mockEnsureBinaryAvailable.mockResolvedValue(undefined);
    mockEnsureDirClean.mockResolvedValue(undefined);
    mockCopySourceTree.mockResolvedValue(undefined);
    mockRunSubprocessCapture.mockResolvedValue({ code: 0, stdout: '', stderr: '', signal: null });
    mockCreateZipFromDir.mockResolvedValue(undefined);
    mockEnforceZipSizeLimit.mockResolvedValue(1024);

    const result = await packager.pack({ build: 'CodeZip', runtimeVersion: 'NODE_20', name: 'myAgent' } as any);

    expect(result.sizeBytes).toBe(1024);
    expect(result.stagingPath).toBe('/project/.staging');
    expect(mockRunSubprocessCapture).toHaveBeenCalledWith(
      'npm',
      expect.arrayContaining(['install', '--omit=dev']),
      expect.any(Object)
    );
  });

  it('throws when npm install fails', async () => {
    mockResolveProjectPaths.mockResolvedValue(defaultPaths);
    mockEnsureBinaryAvailable.mockResolvedValue(undefined);
    mockEnsureDirClean.mockResolvedValue(undefined);
    mockCopySourceTree.mockResolvedValue(undefined);
    mockRunSubprocessCapture.mockResolvedValue({ code: 1, stdout: 'error output', stderr: '', signal: null });

    await expect(packager.pack({ build: 'CodeZip', runtimeVersion: 'NODE_20', name: 'a' } as any)).rejects.toThrow(
      'error output'
    );
  });
});

describe('NodeCodeZipPackagerSync', () => {
  afterEach(() => vi.clearAllMocks());

  const packager = new NodeCodeZipPackagerSync();

  it('throws for non-Node runtime', () => {
    expect(() => packager.packCodeZip({ build: 'CodeZip', runtimeVersion: 'PYTHON_3_12', name: 'a' } as any)).toThrow(
      'only supports Node runtimes'
    );
  });

  it('packs successfully', () => {
    mockResolveProjectPathsSync.mockReturnValue(defaultPaths);
    mockEnsureBinaryAvailableSync.mockReturnValue(undefined);
    mockEnsureDirCleanSync.mockReturnValue(undefined);
    mockCopySourceTreeSync.mockReturnValue(undefined);
    mockRunSubprocessCaptureSync.mockReturnValue({ code: 0, stdout: '', stderr: '', signal: null });
    mockCreateZipFromDirSync.mockReturnValue(undefined);
    mockEnforceZipSizeLimitSync.mockReturnValue(2048);

    const result = packager.packCodeZip({ build: 'CodeZip', runtimeVersion: 'NODE_20', name: 'myAgent' } as any);

    expect(result.sizeBytes).toBe(2048);
  });

  it('throws when npm install fails', () => {
    mockResolveProjectPathsSync.mockReturnValue(defaultPaths);
    mockEnsureBinaryAvailableSync.mockReturnValue(undefined);
    mockEnsureDirCleanSync.mockReturnValue(undefined);
    mockCopySourceTreeSync.mockReturnValue(undefined);
    mockRunSubprocessCaptureSync.mockReturnValue({ code: 1, stdout: '', stderr: 'install failed', signal: null });

    expect(() => packager.packCodeZip({ build: 'CodeZip', runtimeVersion: 'NODE_20', name: 'a' } as any)).toThrow(
      'install failed'
    );
  });
});
