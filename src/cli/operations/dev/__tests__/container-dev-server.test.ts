import { CONTAINER_INTERNAL_PORT } from '../../../../lib/constants';
import type { DevConfig } from '../config';
import { ContainerDevServer } from '../container-dev-server';
import type { DevServerCallbacks, DevServerOptions } from '../dev-server';
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSpawnSync = vi.fn();
const mockSpawn = vi.fn();
const mockExistsSync = vi.fn();
const mockDetectContainerRuntime = vi.fn();
const mockGetStartHint = vi.fn();

vi.mock('child_process', () => ({
  spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}));

vi.mock('os', () => ({
  homedir: () => '/home/testuser',
}));

// This handles the dynamic import in prepare()
// Path is relative to this test file in __tests__/, so 3 levels up to reach cli/
vi.mock('../../../external-requirements/detect', () => ({
  detectContainerRuntime: (...args: unknown[]) => mockDetectContainerRuntime(...args),
  getStartHint: (...args: unknown[]) => mockGetStartHint(...args),
}));

function createMockChildProcess() {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = vi.fn();
  return proc;
}

function mockSuccessfulPrepare() {
  // Runtime detected
  mockDetectContainerRuntime.mockResolvedValue({
    runtime: { runtime: 'docker', binary: 'docker', version: 'Docker 24.0' },
    notReadyRuntimes: [],
  });
  // Dockerfile exists (first call), ~/.aws exists (second call in getSpawnConfig)
  mockExistsSync.mockReturnValue(true);
  // rm, base build, dev build all succeed
  mockSpawnSync.mockReturnValue({ status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') });
  // spawn for the actual server
  const mockChild = createMockChildProcess();
  mockSpawn.mockReturnValue(mockChild);
  return mockChild;
}

const defaultConfig: DevConfig = {
  agentName: 'TestAgent',
  module: 'main.py',
  directory: '/project/app',
  hasConfig: true,
  isPython: true,
  buildType: 'Container' as any,
};

const mockCallbacks: DevServerCallbacks = { onLog: vi.fn(), onExit: vi.fn() };
const defaultOptions: DevServerOptions = { port: 9000, envVars: { MY_VAR: 'val' }, callbacks: mockCallbacks };

describe('ContainerDevServer', () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    savedEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  describe('prepare()', () => {
    it('returns null when no container runtime detected', async () => {
      mockDetectContainerRuntime.mockResolvedValue({
        runtime: null,
        notReadyRuntimes: [],
      });

      const server = new ContainerDevServer(defaultConfig, defaultOptions);
      const result = await server.start();

      expect(result).toBeNull();
      expect(mockCallbacks.onLog).toHaveBeenCalledWith(
        'error',
        'No container runtime found. Install Docker, Podman, or Finch.'
      );
    });

    it('logs start hints when runtimes installed but not ready', async () => {
      mockDetectContainerRuntime.mockResolvedValue({
        runtime: null,
        notReadyRuntimes: ['docker', 'podman'],
      });
      mockGetStartHint.mockReturnValue('Start Docker Desktop');

      const server = new ContainerDevServer(defaultConfig, defaultOptions);
      const result = await server.start();

      expect(result).toBeNull();
      expect(mockCallbacks.onLog).toHaveBeenCalledWith('error', expect.stringContaining('docker, podman'));
      expect(mockGetStartHint).toHaveBeenCalledWith(['docker', 'podman']);
    });

    it('returns null when Dockerfile is missing', async () => {
      mockDetectContainerRuntime.mockResolvedValue({
        runtime: { runtime: 'docker', binary: 'docker', version: 'Docker 24.0' },
        notReadyRuntimes: [],
      });
      mockExistsSync.mockReturnValue(false);

      const server = new ContainerDevServer(defaultConfig, defaultOptions);
      const result = await server.start();

      expect(result).toBeNull();
      expect(mockCallbacks.onLog).toHaveBeenCalledWith('error', expect.stringContaining('Dockerfile not found'));
    });

    it('removes stale container before building', async () => {
      mockSuccessfulPrepare();

      const server = new ContainerDevServer(defaultConfig, defaultOptions);
      await server.start();

      // Find the rm -f call
      const rmCall = mockSpawnSync.mock.calls.find(
        (call: any[]) => Array.isArray(call[1]) && call[1].includes('rm') && call[1].includes('-f')
      );
      expect(rmCall).toBeDefined();
      expect(rmCall![0]).toBe('docker');
      expect(rmCall![1]).toEqual(['rm', '-f', 'agentcore-dev-testagent']);
    });

    it('returns null when base image build fails', async () => {
      mockDetectContainerRuntime.mockResolvedValue({
        runtime: { runtime: 'docker', binary: 'docker', version: 'Docker 24.0' },
        notReadyRuntimes: [],
      });
      mockExistsSync.mockReturnValue(true);
      // rm succeeds, base build fails
      mockSpawnSync
        .mockReturnValueOnce({ status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') }) // rm
        .mockReturnValueOnce({ status: 1, stdout: Buffer.from(''), stderr: Buffer.from('build error') }); // base build

      const server = new ContainerDevServer(defaultConfig, defaultOptions);
      const result = await server.start();

      expect(result).toBeNull();
      expect(mockCallbacks.onLog).toHaveBeenCalledWith('error', expect.stringContaining('Container build failed'));
    });

    it('returns null when dev layer build fails', async () => {
      mockDetectContainerRuntime.mockResolvedValue({
        runtime: { runtime: 'docker', binary: 'docker', version: 'Docker 24.0' },
        notReadyRuntimes: [],
      });
      mockExistsSync.mockReturnValue(true);
      // rm succeeds, base build succeeds, dev build fails
      mockSpawnSync
        .mockReturnValueOnce({ status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') }) // rm
        .mockReturnValueOnce({ status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') }) // base build
        .mockReturnValueOnce({ status: 1, stdout: Buffer.from(''), stderr: Buffer.from('dev error') }); // dev build

      const server = new ContainerDevServer(defaultConfig, defaultOptions);
      const result = await server.start();

      expect(result).toBeNull();
      expect(mockCallbacks.onLog).toHaveBeenCalledWith('error', expect.stringContaining('Dev layer build failed'));
    });

    it('succeeds when both builds pass and logs success message', async () => {
      mockSuccessfulPrepare();

      const server = new ContainerDevServer(defaultConfig, defaultOptions);
      const result = await server.start();

      expect(result).not.toBeNull();
      expect(mockCallbacks.onLog).toHaveBeenCalledWith('system', 'Container image built successfully.');
    });

    it('dev layer Dockerfile contains RUN uv pip install uvicorn', async () => {
      mockSuccessfulPrepare();

      const server = new ContainerDevServer(defaultConfig, defaultOptions);
      await server.start();

      // The dev build is the 3rd spawnSync call (rm, base build, dev build)
      const devBuildCall = mockSpawnSync.mock.calls[2]!;
      expect(devBuildCall).toBeDefined();
      // The input option contains the dev Dockerfile
      const input = devBuildCall[2]?.input as string;
      expect(input).toContain('RUN uv pip install uvicorn');
    });

    it('dev layer FROM references the base image name', async () => {
      mockSuccessfulPrepare();

      const server = new ContainerDevServer(defaultConfig, defaultOptions);
      await server.start();

      const devBuildCall = mockSpawnSync.mock.calls[2]!;
      const input = devBuildCall[2]?.input as string;
      expect(input).toContain('FROM agentcore-dev-testagent-base');
    });

    it('logs non-empty build output lines at system level', async () => {
      mockDetectContainerRuntime.mockResolvedValue({
        runtime: { runtime: 'docker', binary: 'docker', version: 'Docker 24.0' },
        notReadyRuntimes: [],
      });
      mockExistsSync.mockReturnValue(true);
      mockSpawnSync
        .mockReturnValueOnce({ status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') }) // rm
        .mockReturnValueOnce({
          status: 0,
          stdout: Buffer.from('Step 1/3: FROM python\nStep 2/3: COPY . .\n'),
          stderr: Buffer.from(''),
        }) // base build
        .mockReturnValueOnce({ status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') }); // dev build

      const mockChild = createMockChildProcess();
      mockSpawn.mockReturnValue(mockChild);

      const server = new ContainerDevServer(defaultConfig, defaultOptions);
      await server.start();

      expect(mockCallbacks.onLog).toHaveBeenCalledWith('system', 'Step 1/3: FROM python');
      expect(mockCallbacks.onLog).toHaveBeenCalledWith('system', 'Step 2/3: COPY . .');
    });
  });

  /** Extract the args array from the first mockSpawn call. */
  function getSpawnArgs(): string[] {
    return mockSpawn.mock.calls[0]![1] as string[];
  }

  describe('getSpawnConfig() — verified via spawn args', () => {
    it('uses lowercased image name', async () => {
      mockSuccessfulPrepare();

      const server = new ContainerDevServer(defaultConfig, defaultOptions);
      await server.start();

      const spawnArgs = getSpawnArgs();
      expect(spawnArgs).toContain('agentcore-dev-testagent');
    });

    it('includes run, --rm, --name, containerName', async () => {
      mockSuccessfulPrepare();

      const server = new ContainerDevServer(defaultConfig, defaultOptions);
      await server.start();

      const spawnArgs = getSpawnArgs();
      expect(spawnArgs[0]).toBe('run');
      expect(spawnArgs).toContain('--rm');
      expect(spawnArgs).toContain('--name');
      const nameIdx = spawnArgs.indexOf('--name');
      expect(spawnArgs[nameIdx + 1]).toBe('agentcore-dev-testagent');
    });

    it('overrides entrypoint to python', async () => {
      mockSuccessfulPrepare();

      const server = new ContainerDevServer(defaultConfig, defaultOptions);
      await server.start();

      const spawnArgs = getSpawnArgs();
      const entrypointIdx = spawnArgs.indexOf('--entrypoint');
      expect(entrypointIdx).toBeGreaterThan(-1);
      expect(spawnArgs[entrypointIdx + 1]).toBe('python');
    });

    it('mounts source directory as /app volume', async () => {
      mockSuccessfulPrepare();

      const server = new ContainerDevServer(defaultConfig, defaultOptions);
      await server.start();

      const spawnArgs = getSpawnArgs();
      expect(spawnArgs).toContain('-v');
      expect(spawnArgs).toContain('/project/app:/app');
    });

    it('maps host port to container internal port', async () => {
      mockSuccessfulPrepare();

      const server = new ContainerDevServer(defaultConfig, defaultOptions);
      await server.start();

      const spawnArgs = getSpawnArgs();
      expect(spawnArgs).toContain('-p');
      expect(spawnArgs).toContain(`9000:${CONTAINER_INTERNAL_PORT}`);
    });

    it('includes user-provided environment variables', async () => {
      mockSuccessfulPrepare();

      const server = new ContainerDevServer(defaultConfig, defaultOptions);
      await server.start();

      const spawnArgs = getSpawnArgs();
      expect(spawnArgs).toContain('MY_VAR=val');
    });

    it('includes LOCAL_DEV=1 and PORT env vars', async () => {
      mockSuccessfulPrepare();

      const server = new ContainerDevServer(defaultConfig, defaultOptions);
      await server.start();

      const spawnArgs = getSpawnArgs();
      expect(spawnArgs).toContain('LOCAL_DEV=1');
      expect(spawnArgs).toContain(`PORT=${CONTAINER_INTERNAL_PORT}`);
    });

    it('forwards AWS env vars when present in process.env', async () => {
      process.env.AWS_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
      process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
      process.env.AWS_SESSION_TOKEN = 'FwoGZXIvYXdzEBY';
      process.env.AWS_REGION = 'us-east-1';
      process.env.AWS_DEFAULT_REGION = 'us-west-2';
      process.env.AWS_PROFILE = 'dev-profile';

      mockSuccessfulPrepare();

      const server = new ContainerDevServer(defaultConfig, defaultOptions);
      await server.start();

      const spawnArgs = getSpawnArgs();
      expect(spawnArgs).toContain('AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE');
      expect(spawnArgs).toContain('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
      expect(spawnArgs).toContain('AWS_SESSION_TOKEN=FwoGZXIvYXdzEBY');
      expect(spawnArgs).toContain('AWS_REGION=us-east-1');
      expect(spawnArgs).toContain('AWS_DEFAULT_REGION=us-west-2');
      expect(spawnArgs).toContain('AWS_PROFILE=dev-profile');
    });

    it('does not include AWS env vars when not set', async () => {
      delete process.env.AWS_ACCESS_KEY_ID;
      delete process.env.AWS_SECRET_ACCESS_KEY;
      delete process.env.AWS_SESSION_TOKEN;
      delete process.env.AWS_REGION;
      delete process.env.AWS_DEFAULT_REGION;
      delete process.env.AWS_PROFILE;

      mockSuccessfulPrepare();

      const server = new ContainerDevServer(defaultConfig, defaultOptions);
      await server.start();

      const spawnArgs = getSpawnArgs();
      const awsArgs = spawnArgs.filter((arg: string) => arg.startsWith('AWS_'));
      expect(awsArgs).toHaveLength(0);
    });

    it('mounts ~/.aws when exists', async () => {
      mockSuccessfulPrepare();
      // existsSync returns true for all calls (Dockerfile and ~/.aws)

      const server = new ContainerDevServer(defaultConfig, defaultOptions);
      await server.start();

      const spawnArgs = getSpawnArgs();
      expect(spawnArgs).toContain('/home/testuser/.aws:/home/bedrock_agentcore/.aws:ro');
    });

    it('skips ~/.aws mount when directory does not exist', async () => {
      mockDetectContainerRuntime.mockResolvedValue({
        runtime: { runtime: 'docker', binary: 'docker', version: 'Docker 24.0' },
        notReadyRuntimes: [],
      });
      // existsSync is called for: (1) Dockerfile in prepare(), (2) ~/.aws in getSpawnConfig()
      mockExistsSync.mockImplementation((path: string) => {
        if (typeof path === 'string' && path.includes('.aws')) return false;
        return true; // Dockerfile exists
      });
      mockSpawnSync.mockReturnValue({ status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') });
      const mockChild = createMockChildProcess();
      mockSpawn.mockReturnValue(mockChild);

      const server = new ContainerDevServer(defaultConfig, defaultOptions);
      await server.start();

      const spawnArgs = getSpawnArgs();
      const awsMountArg = spawnArgs.find((arg: string) => arg.includes('.aws'));
      expect(awsMountArg).toBeUndefined();
    });

    it('uses uvicorn with --reload and --reload-dir /app', async () => {
      mockSuccessfulPrepare();

      const server = new ContainerDevServer(defaultConfig, defaultOptions);
      await server.start();

      const spawnArgs = getSpawnArgs();
      expect(spawnArgs).toContain('-m');
      expect(spawnArgs).toContain('uvicorn');
      expect(spawnArgs).toContain('--reload');
      expect(spawnArgs).toContain('--reload-dir');
      expect(spawnArgs).toContain('/app');
    });

    it('converts entrypoint via convertEntrypointToModule (main.py -> main:app)', async () => {
      mockSuccessfulPrepare();

      const server = new ContainerDevServer(defaultConfig, defaultOptions);
      await server.start();

      const spawnArgs = getSpawnArgs();
      expect(spawnArgs).toContain('main:app');
    });
  });

  describe('kill()', () => {
    it('stops container using docker stop before calling super.kill()', async () => {
      mockSuccessfulPrepare();

      const server = new ContainerDevServer(defaultConfig, defaultOptions);
      const child = await server.start();

      // Clear mocks to isolate the kill call
      mockSpawnSync.mockClear();

      server.kill();

      expect(mockSpawnSync).toHaveBeenCalledWith('docker', ['stop', 'agentcore-dev-testagent'], { stdio: 'ignore' });
      expect(child!.kill).toHaveBeenCalledWith('SIGTERM'); // eslint-disable-line @typescript-eslint/unbound-method
    });

    it('does not call container stop when runtimeBinary is empty (prepare not called)', () => {
      const server = new ContainerDevServer(defaultConfig, defaultOptions);

      server.kill();

      expect(mockSpawnSync).not.toHaveBeenCalled();
    });
  });
});
