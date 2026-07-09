import { ContainerPackager } from '../container.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockSpawnSync = vi.fn();
const mockExistsSync = vi.fn();
const mockResolveCodeLocation = vi.fn();

vi.mock('child_process', () => ({
  spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
}));

vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}));

vi.mock('../helpers', () => ({
  resolveCodeLocation: (...args: unknown[]) => mockResolveCodeLocation(...args),
}));

describe('ContainerPackager', () => {
  afterEach(() => vi.clearAllMocks());

  const packager = new ContainerPackager();

  const baseSpec = {
    build: 'Container' as const,
    name: 'agent',
    codeLocation: './src',
    entrypoint: 'main.py',
  };

  it('rejects with PackagingError for non-Container build type', async () => {
    await expect(packager.pack({ build: 'CodeZip', name: 'a' } as any)).rejects.toThrow(
      'only supports Container build type'
    );
  });

  it('rejects when Dockerfile not found', async () => {
    mockResolveCodeLocation.mockReturnValue('/resolved/src');
    mockExistsSync.mockReturnValue(false);

    await expect(packager.pack(baseSpec as any)).rejects.toThrow('Dockerfile not found');
  });

  it('resolves with empty artifact when no container runtime available', async () => {
    mockResolveCodeLocation.mockReturnValue('/resolved/src');
    mockExistsSync.mockReturnValue(true);
    mockSpawnSync.mockImplementation((cmd: string) => {
      if (cmd === 'which') {
        return { status: 1 };
      }
      return { status: 1 };
    });

    const result = await packager.pack(baseSpec as any);

    expect(result.artifactPath).toBe('');
    expect(result.sizeBytes).toBe(0);
    expect(result.stagingPath).toBe('/resolved/src');
  });

  it('builds and returns artifact with docker runtime', async () => {
    mockResolveCodeLocation.mockReturnValue('/resolved/src');
    mockExistsSync.mockReturnValue(true);
    mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'which' && args[0] === 'docker') return { status: 0 };
      if (cmd === 'docker' && args[0] === '--version') return { status: 0 };
      if (cmd === 'docker' && args[0] === 'build') return { status: 0 };
      if (cmd === 'docker' && args[0] === 'image') return { status: 0, stdout: Buffer.from('50000000') };
      return { status: 1 };
    });

    const result = await packager.pack(baseSpec as any);

    expect(result.artifactPath).toBe('docker://agentcore-package-agent');
    expect(result.sizeBytes).toBe(50000000);
    expect(result.stagingPath).toBe('/resolved/src');
  });

  it('rejects when docker build fails', async () => {
    mockResolveCodeLocation.mockReturnValue('/resolved/src');
    mockExistsSync.mockReturnValue(true);
    mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'which' && args[0] === 'docker') return { status: 0 };
      if (cmd === 'docker' && args[0] === '--version') return { status: 0 };
      if (cmd === 'docker' && args[0] === 'build') return { status: 1, stderr: Buffer.from('build error occurred') };
      return { status: 1 };
    });

    await expect(packager.pack(baseSpec as any)).rejects.toThrow('Container build failed');
  });

  it('rejects when image exceeds 1GB size limit', async () => {
    mockResolveCodeLocation.mockReturnValue('/resolved/src');
    mockExistsSync.mockReturnValue(true);
    const oversized = (1024 * 1024 * 1024 + 1).toString();
    mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'which' && args[0] === 'docker') return { status: 0 };
      if (cmd === 'docker' && args[0] === '--version') return { status: 0 };
      if (cmd === 'docker' && args[0] === 'build') return { status: 0 };
      if (cmd === 'docker' && args[0] === 'image') return { status: 0, stdout: Buffer.from(oversized) };
      return { status: 1 };
    });

    await expect(packager.pack(baseSpec as any)).rejects.toThrow('exceeds 1GB limit');
  });

  it('uses options.agentName over spec.name', async () => {
    mockResolveCodeLocation.mockReturnValue('/resolved/src');
    mockExistsSync.mockReturnValue(true);
    mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'which' && args[0] === 'docker') return { status: 0 };
      if (cmd === 'docker' && args[0] === '--version') return { status: 0 };
      if (cmd === 'docker' && args[0] === 'build') return { status: 0 };
      if (cmd === 'docker' && args[0] === 'image') return { status: 0, stdout: Buffer.from('1000') };
      return { status: 1 };
    });

    const result = await packager.pack(baseSpec as any, { agentName: 'custom-agent' });

    expect(result.artifactPath).toBe('docker://agentcore-package-custom-agent');
  });

  it('lower-cases the image tag for a mixed-case agent name (docker tags must be lowercase)', async () => {
    mockResolveCodeLocation.mockReturnValue('/resolved/src');
    mockExistsSync.mockReturnValue(true);
    mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'which' && args[0] === 'docker') return { status: 0 };
      if (cmd === 'docker' && args[0] === '--version') return { status: 0 };
      if (cmd === 'docker' && args[0] === 'build') return { status: 0 };
      if (cmd === 'docker' && args[0] === 'image') return { status: 0, stdout: Buffer.from('1000') };
      return { status: 1 };
    });

    const result = await packager.pack({ ...baseSpec, name: 'AgentOne' } as any);

    // Docker rejects uppercase in image tags; the default agent name is PascalCase, so it must be lowered.
    expect(result.artifactPath).toBe('docker://agentcore-package-agentone');
    const buildCall = mockSpawnSync.mock.calls.find(
      (c: unknown[]) => c[0] === 'docker' && (c[1] as string[])[0] === 'build'
    );
    const buildArgs = buildCall![1] as string[];
    expect(buildArgs[buildArgs.indexOf('-t') + 1]).toBe('agentcore-package-agentone');
  });

  it('uses options.artifactDir as configBaseDir', async () => {
    mockResolveCodeLocation.mockReturnValue('/artifact/dir/src');
    mockExistsSync.mockReturnValue(true);
    mockSpawnSync.mockImplementation((cmd: string) => {
      if (cmd === 'which') return { status: 1 };
      return { status: 1 };
    });

    await packager.pack(baseSpec as any, { artifactDir: '/artifact/dir' });

    expect(mockResolveCodeLocation).toHaveBeenCalledWith('./src', '/artifact/dir');
  });

  it('uses options.projectRoot as fallback', async () => {
    mockResolveCodeLocation.mockReturnValue('/project/root/src');
    mockExistsSync.mockReturnValue(true);
    mockSpawnSync.mockImplementation((cmd: string) => {
      if (cmd === 'which') return { status: 1 };
      return { status: 1 };
    });

    await packager.pack(baseSpec as any, { projectRoot: '/project/root' });

    expect(mockResolveCodeLocation).toHaveBeenCalledWith('./src', '/project/root');
  });

  it('falls back to process.cwd() when no directory options', async () => {
    const cwd = process.cwd();
    mockResolveCodeLocation.mockReturnValue('/cwd/src');
    mockExistsSync.mockReturnValue(true);
    mockSpawnSync.mockImplementation((cmd: string) => {
      if (cmd === 'which') return { status: 1 };
      return { status: 1 };
    });

    await packager.pack(baseSpec as any);

    expect(mockResolveCodeLocation).toHaveBeenCalledWith('./src', cwd);
  });

  it('detects finch runtime when docker unavailable', async () => {
    mockResolveCodeLocation.mockReturnValue('/resolved/src');
    mockExistsSync.mockReturnValue(true);
    mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'which' && args[0] === 'docker') return { status: 1 };
      if (cmd === 'which' && args[0] === 'finch') return { status: 0 };
      if (cmd === 'finch' && args[0] === '--version') return { status: 0 };
      if (cmd === 'finch' && args[0] === 'build') return { status: 0 };
      if (cmd === 'finch' && args[0] === 'image') return { status: 0, stdout: Buffer.from('2000') };
      return { status: 1 };
    });

    const result = await packager.pack(baseSpec as any);

    expect(result.artifactPath).toBe('finch://agentcore-package-agent');
  });

  it('uses custom dockerfile name from spec', async () => {
    mockResolveCodeLocation.mockReturnValue('/resolved/src');
    mockExistsSync.mockReturnValue(true);
    mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'which' && args[0] === 'docker') return { status: 0 };
      if (cmd === 'docker' && args[0] === '--version') return { status: 0 };
      if (cmd === 'docker' && args[0] === 'build') return { status: 0 };
      if (cmd === 'docker' && args[0] === 'image') return { status: 0, stdout: Buffer.from('1000') };
      return { status: 1 };
    });

    const specWithDockerfile = { ...baseSpec, dockerfile: 'Dockerfile.gpu' };
    await packager.pack(specWithDockerfile as any);

    // Verify build was called with custom dockerfile path
    const buildCall = mockSpawnSync.mock.calls.find(
      (c: unknown[]) => c[0] === 'docker' && (c[1] as string[])[0] === 'build'
    );
    expect(buildCall).toBeDefined();
    const buildArgs = buildCall![1] as string[];
    const fIdx = buildArgs.indexOf('-f');
    expect(buildArgs[fIdx + 1]).toBe('/resolved/src/Dockerfile.gpu');
  });

  it('rejects when custom dockerfile not found', async () => {
    mockResolveCodeLocation.mockReturnValue('/resolved/src');
    mockExistsSync.mockReturnValue(false);

    const specWithDockerfile = { ...baseSpec, dockerfile: 'Dockerfile.custom' };
    await expect(packager.pack(specWithDockerfile as any)).rejects.toThrow('Dockerfile.custom not found');
  });

  it('uses buildContextPath as docker build context instead of codeLocation', async () => {
    mockResolveCodeLocation.mockImplementation((path: string) => {
      if (path === './src') return '/resolved/src';
      if (path === './context') return '/resolved/context';
      return path;
    });
    mockExistsSync.mockReturnValue(true);
    mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'which' && args[0] === 'docker') return { status: 0 };
      if (cmd === 'docker' && args[0] === '--version') return { status: 0 };
      if (cmd === 'docker' && args[0] === 'build') return { status: 0 };
      if (cmd === 'docker' && args[0] === 'image') return { status: 0, stdout: Buffer.from('1000') };
      return { status: 1 };
    });

    const specWithContext = { ...baseSpec, buildContextPath: './context' };
    await packager.pack(specWithContext as any);

    const buildCall = mockSpawnSync.mock.calls.find(
      (c: unknown[]) => c[0] === 'docker' && (c[1] as string[])[0] === 'build'
    );
    expect(buildCall).toBeDefined();
    const buildArgs = buildCall![1] as string[];
    // Last arg should be the buildContextPath, not codeLocation
    expect(buildArgs[buildArgs.length - 1]).toBe('/resolved/context');
    // The Dockerfile (-f) must be resolved against the build context, not codeLocation — otherwise the
    // local build diverges from the deploy build (which resolves it against the uploaded context root).
    const fIdx = buildArgs.indexOf('-f');
    expect(buildArgs[fIdx + 1]).toBe('/resolved/context/Dockerfile');
  });

  it('passes customDockerBuildArgs as --build-arg flags', async () => {
    mockResolveCodeLocation.mockReturnValue('/resolved/src');
    mockExistsSync.mockReturnValue(true);
    mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'which' && args[0] === 'docker') return { status: 0 };
      if (cmd === 'docker' && args[0] === '--version') return { status: 0 };
      if (cmd === 'docker' && args[0] === 'build') return { status: 0 };
      if (cmd === 'docker' && args[0] === 'image') return { status: 0, stdout: Buffer.from('1000') };
      return { status: 1 };
    });

    const specWithBuildArgs = { ...baseSpec, customDockerBuildArgs: { AGENT_NAME: 'dummyagent', BUILD_ENV: 'prod' } };
    await packager.pack(specWithBuildArgs as any);

    const buildCall = mockSpawnSync.mock.calls.find(
      (c: unknown[]) => c[0] === 'docker' && (c[1] as string[])[0] === 'build'
    );
    expect(buildCall).toBeDefined();
    const buildArgs = buildCall![1] as string[];
    expect(buildArgs).toContain('--build-arg');
    expect(buildArgs).toContain('AGENT_NAME=dummyagent');
    expect(buildArgs).toContain('BUILD_ENV=prod');
  });

  it('detects podman runtime last', async () => {
    mockResolveCodeLocation.mockReturnValue('/resolved/src');
    mockExistsSync.mockReturnValue(true);
    mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'which' && args[0] === 'docker') return { status: 1 };
      if (cmd === 'which' && args[0] === 'finch') return { status: 1 };
      if (cmd === 'which' && args[0] === 'podman') return { status: 0 };
      if (cmd === 'podman' && args[0] === '--version') return { status: 0 };
      if (cmd === 'podman' && args[0] === 'build') return { status: 0 };
      if (cmd === 'podman' && args[0] === 'image') return { status: 0, stdout: Buffer.from('3000') };
      return { status: 1 };
    });

    const result = await packager.pack(baseSpec as any);

    expect(result.artifactPath).toBe('podman://agentcore-package-agent');
  });
});
