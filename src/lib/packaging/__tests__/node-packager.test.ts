import { NodeCodeZipPackager, NodeCodeZipPackagerSync } from '../node.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    writeFileSync: vi.fn(),
    existsSync: vi.fn(() => false),
    cpSync: vi.fn(),
  };
});

const mockBuild = vi.fn();
const mockBuildSync = vi.fn();
const mockResolveNodeProjectPaths = vi.fn();
const mockResolveNodeProjectPathsSync = vi.fn();
const mockEnsureDirClean = vi.fn();
const mockEnsureDirCleanSync = vi.fn();
const mockCreateZipFromDir = vi.fn();
const mockCreateZipFromDirSync = vi.fn();
const mockEnforceZipSizeLimit = vi.fn();
const mockEnforceZipSizeLimitSync = vi.fn();

vi.mock('esbuild', () => ({
  build: (...args: unknown[]) => mockBuild(...args),
  buildSync: (...args: unknown[]) => mockBuildSync(...args),
}));

vi.mock('../helpers', () => ({
  resolveNodeProjectPaths: (...args: unknown[]) => mockResolveNodeProjectPaths(...args),
  resolveNodeProjectPathsSync: (...args: unknown[]) => mockResolveNodeProjectPathsSync(...args),
  ensureDirClean: (...args: unknown[]) => mockEnsureDirClean(...args),
  ensureDirCleanSync: (...args: unknown[]) => mockEnsureDirCleanSync(...args),
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
  pyprojectPath: '/project/package.json',
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

  it('packs successfully using esbuild', async () => {
    mockResolveNodeProjectPaths.mockResolvedValue(defaultPaths);
    mockEnsureDirClean.mockResolvedValue(undefined);
    mockBuild.mockResolvedValue(undefined);
    mockCreateZipFromDir.mockResolvedValue(undefined);
    mockEnforceZipSizeLimit.mockResolvedValue(1024);

    const result = await packager.pack({ build: 'CodeZip', runtimeVersion: 'NODE_20', name: 'myAgent' } as any);

    expect(result.sizeBytes).toBe(1024);
    expect(result.stagingPath).toBe('/project/.staging');
    expect(mockBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        entryPoints: ['/project/src/main.ts'],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node20',
      })
    );
  });

  it('throws when esbuild fails', async () => {
    mockResolveNodeProjectPaths.mockResolvedValue(defaultPaths);
    mockEnsureDirClean.mockResolvedValue(undefined);
    mockBuild.mockRejectedValue(new Error('Build failed: could not resolve module'));

    await expect(packager.pack({ build: 'CodeZip', runtimeVersion: 'NODE_20', name: 'a' } as any)).rejects.toThrow(
      'could not resolve module'
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

  it('packs successfully using esbuild', () => {
    mockResolveNodeProjectPathsSync.mockReturnValue(defaultPaths);
    mockEnsureDirCleanSync.mockReturnValue(undefined);
    mockBuildSync.mockReturnValue(undefined);
    mockCreateZipFromDirSync.mockReturnValue(undefined);
    mockEnforceZipSizeLimitSync.mockReturnValue(2048);

    const result = packager.packCodeZip({ build: 'CodeZip', runtimeVersion: 'NODE_20', name: 'myAgent' } as any);

    expect(result.sizeBytes).toBe(2048);
    expect(mockBuildSync).toHaveBeenCalledWith(
      expect.objectContaining({
        entryPoints: ['/project/src/main.ts'],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node20',
      })
    );
  });

  it('throws when esbuild fails', () => {
    mockResolveNodeProjectPathsSync.mockReturnValue(defaultPaths);
    mockEnsureDirCleanSync.mockReturnValue(undefined);
    mockBuildSync.mockImplementation(() => {
      throw new Error('Build failed');
    });

    expect(() => packager.packCodeZip({ build: 'CodeZip', runtimeVersion: 'NODE_20', name: 'a' } as any)).toThrow(
      'Build failed'
    );
  });
});
