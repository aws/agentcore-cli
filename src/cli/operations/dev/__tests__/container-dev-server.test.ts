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
const mockWaitForServerReady = vi.fn();

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
}));

vi.mock('../utils', async importOriginal => {
  const actual: Record<string, unknown> = await importOriginal();
  return {
    ...actual,
    waitForServerReady: (...args: unknown[]) => mockWaitForServerReady(...args),
  };
});

function createMockChildProcess() {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = vi.fn();
  return proc;
}

/** Create a mock child process that auto-closes with the given exit code (for build). */
function createMockBuildProcess(exitCode = 0, stdoutData?: string) {
  const proc = createMockChildProcess();
  // Emit 'close' after the listener is attached to guarantee correct ordering
  const origOn = proc.on.bind(proc);
  proc.on = function (event: string, fn: (...args: any[]) => void) {
    origOn(event, fn);
    if (event === 'close') {
      process.nextTick(() => {
        if (stdoutData) proc.stdout.emit('data', Buffer.from(stdoutData));
        proc.emit('close', exitCode);
      });
    }
    return proc;
  };
  return proc;
}

function mockSuccessfulPrepare() {
  // Runtime detected
  mockDetectContainerRuntime.mockResolvedValue({
    runtime: { runtime: 'docker', binary: 'docker', version: 'Docker 24.0' },
  });
  // Dockerfile exists (first call), ~/.aws exists (second call in getSpawnConfig)
  mockExistsSync.mockReturnValue(true);
  // rm succeeds (spawnSync)
  mockSpawnSync.mockReturnValue({ status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') });
  // spawn: first call = build (auto-closes with 0), second call = server run
  const mockBuild = createMockBuildProcess(0);
  const mockChild = createMockChildProcess();
  mockSpawn.mockReturnValueOnce(mockBuild).mockReturnValueOnce(mockChild);
  return mockChild;
}

const defaultConfig: DevConfig = {
  agentName: 'TestAgent',
  module: 'main.py',
  directory: '/project/app',
  hasConfig: true,
  isPython: true,
  buildType: 'Container' as any,
  protocol: 'HTTP',
};

const mockCallbacks: DevServerCallbacks = { onLog: vi.fn(), onExit: vi.fn() };
const defaultOptions: DevServerOptions = { port: 9000, envVars: { MY_VAR: 'val' }, callbacks: mockCallbacks };

describe('ContainerDevServer', () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    savedEnv = { ...process.env };
    // Default: container server becomes ready immediately
    mockWaitForServerReady.mockResolvedValue(true);
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  describe('prepare()', () => {
    it('returns null when no container runtime detected', async () => {
      mockDetectContainerRuntime.mockResolvedValue({
        runtime: null,
      });

      const server = new ContainerDevServer(defaultConfig, defaultOptions);
      const result = await server.start();

      expect(result).toBeNull();
      expect(mockCallbacks.onLog).toHaveBeenCalledWith(
        'error',
        'No container runtime found. Install Docker, Podman, or Finch.'
      );
    });

    it('returns null when Dockerfile is missing', async () => {
      mockDetectContainerRuntime.mockResolvedValue({
        runtime: { runtime: 'docker', binary: 'docker', version: 'Docker 24.0' },
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

    it('returns null when image build fails', async () => {
      mockDetectContainerRuntime.mockResolvedValue({
        runtime: { runtime: 'docker', binary: 'docker', version: 'Docker 24.0' },
      });
      mockExistsSync.mockReturnValue(true);
      // rm succeeds (spawnSync)
      mockSpawnSync.mockReturnValue({ status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') });
      // build fails (spawn, auto-closes with exit code 1)
      mockSpawn.mockReturnValue(createMockBuildProcess(1));

      const server = new ContainerDevServer(defaultConfig, defaultOptions);
      const result = await server.start();

      expect(result).toBeNull();
      expect(mockCallbacks.onLog).toHaveBeenCalledWith('error', expect.stringContaining('Container build failed'));
    });

    it('succeeds when build passes and logs success message', async () => {
      mockSuccessfulPrepare();

      const server = new ContainerDevServer(defaultConfig, defaultOptions);
      const result = await server.start();

      expect(result).not.toBeNull();
      expect(mockCallbacks.onLog).toHaveBeenCalledWith('system', 'Container image built successfully.');
    });

    it('waits for server to be ready before triggering TUI readiness', async () => {
      mockSuccessfulPrepare();

      const server = new ContainerDevServer(defaultConfig, defaultOptions);
      await server.start();

      expect(mockCallbacks.onLog).toHaveBeenCalledWith(
        'system',
        'Container agentcore-dev-testagent started, waiting for server to be ready...'
      );
      expect(mockWaitForServerReady).toHaveBeenCalledWith(9000);
      // Emits readiness trigger for TUI detection only after port is ready
      expect(mockCallbacks.onLog).toHaveBeenCalledWith('info', 'Application startup complete');
    });

    it('logs error when container server does not become ready in time', async () => {
      mockSuccessfulPrepare();
      mockWaitForServerReady.mockResolvedValue(false);

      const server = new ContainerDevServer(defaultConfig, defaultOptions);
      await server.start();

      expect(mockCallbacks.onLog).toHaveBeenCalledWith(
        'error',
        'Container server did not become ready within 60 seconds.'
      );
      // Should NOT emit readiness trigger
      expect(mockCallbacks.onLog).not.toHaveBeenCalledWith('info', 'Application startup complete');
    });

    it('builds image directly without a dev layer', async () => {
      mockSuccessfulPrepare();

      const server = new ContainerDevServer(defaultConfig, defaultOptions);
      await server.start();

      // rm call uses spawnSync (build uses async spawn); resolveHostCredentials may also call spawnSync
      expect(mockSpawnSync).toHaveBeenCalledWith('docker', expect.arrayContaining(['rm', '-f']), expect.anything());
      // First spawn call is the build
      const buildCall = mockSpawn.mock.calls[0]!;
      const buildArgs = buildCall[1] as string[];
      // Image is built directly as agentcore-dev-testagent (no -base suffix)
      expect(buildArgs).toContain('-t');
      const tagIdx = buildArgs.indexOf('-t');
      expect(buildArgs[tagIdx + 1]).toBe('agentcore-dev-testagent');
    });

    it('streams build output lines at system level in real-time', async () => {
      mockDetectContainerRuntime.mockResolvedValue({
        runtime: { runtime: 'docker', binary: 'docker', version: 'Docker 24.0' },
      });
      mockExistsSync.mockReturnValue(true);
      mockSpawnSync.mockReturnValue({ status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') }); // rm

      // Build process that emits stdout lines then closes
      const buildProc = createMockBuildProcess(0, 'Step 1/3: FROM python\nStep 2/3: COPY . .\n');
      const serverProc = createMockChildProcess();
      mockSpawn.mockReturnValueOnce(buildProc).mockReturnValueOnce(serverProc);

      const server = new ContainerDevServer(defaultConfig, defaultOptions);
      await server.start();

      expect(mockCallbacks.onLog).toHaveBeenCalledWith('system', 'Step 1/3: FROM python');
      expect(mockCallbacks.onLog).toHaveBeenCalledWith('system', 'Step 2/3: COPY . .');
    });
  });

  /** Extract the args array from the server run spawn call (second spawn — first is the build). */
  function getSpawnArgs(): string[] {
    return mockSpawn.mock.calls[1]![1] as string[];
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

    it('does not override entrypoint — uses Dockerfile CMD/ENTRYPOINT', async () => {
      mockSuccessfulPrepare();

      const server = new ContainerDevServer(defaultConfig, defaultOptions);
      await server.start();

      const spawnArgs = getSpawnArgs();
      expect(spawnArgs).not.toContain('--entrypoint');
    });

    it('does not override user', async () => {
      mockSuccessfulPrepare();

      const server = new ContainerDevServer(defaultConfig, defaultOptions);
      await server.start();

      const spawnArgs = getSpawnArgs();
      expect(spawnArgs).not.toContain('--user');
    });

    it('does not mount source directory as volume', async () => {
      mockSuccessfulPrepare();

      const server = new ContainerDevServer(defaultConfig, defaultOptions);
      await server.start();

      const spawnArgs = getSpawnArgs();
      // No source:/app volume mount (only ~/.aws mount should be present)
      const volumeArgs = spawnArgs.filter((arg: string) => arg.includes(':/app'));
      expect(volumeArgs).toHaveLength(0);
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

    it('forwards OTEL env vars from caller to the container', async () => {
      mockSuccessfulPrepare();

      const options = {
        ...defaultOptions,
        envVars: {
          OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
          OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
        },
      };
      const server = new ContainerDevServer(defaultConfig, options);
      await server.start();

      const spawnArgs = getSpawnArgs();
      expect(spawnArgs).toContain('OTEL_EXPORTER_OTLP_ENDPOINT=http://host.docker.internal:4318');
      expect(spawnArgs).toContain('OTEL_EXPORTER_OTLP_PROTOCOL=http/json');
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
      expect(spawnArgs).not.toContain('AWS_PROFILE=dev-profile');
    });

    it('forwards AWS_PROFILE when no explicit credentials are set', async () => {
      delete process.env.AWS_ACCESS_KEY_ID;
      delete process.env.AWS_SECRET_ACCESS_KEY;
      delete process.env.AWS_SESSION_TOKEN;
      process.env.AWS_REGION = 'us-east-1';
      process.env.AWS_PROFILE = 'dev-profile';

      mockSuccessfulPrepare();

      const server = new ContainerDevServer(defaultConfig, defaultOptions);
      await server.start();

      const spawnArgs = getSpawnArgs();
      expect(spawnArgs).toContain('AWS_PROFILE=dev-profile');
      expect(spawnArgs).toContain('AWS_REGION=us-east-1');
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
      // Filter only forwarded AWS cred env vars, not AWS_CONFIG_FILE/CREDENTIALS_FILE
      const awsArgs = spawnArgs.filter((arg: string) => arg.startsWith('AWS_') && !arg.includes('_FILE='));
      expect(awsArgs).toHaveLength(0);
    });

    it('mounts ~/.aws to /aws-config for any container user', async () => {
      mockSuccessfulPrepare();
      // existsSync returns true for all calls (Dockerfile and ~/.aws)

      const server = new ContainerDevServer(defaultConfig, defaultOptions);
      await server.start();

      const spawnArgs = getSpawnArgs();
      expect(spawnArgs).toContain('/home/testuser/.aws:/aws-config:ro');
    });

    it('sets AWS_CONFIG_FILE and AWS_SHARED_CREDENTIALS_FILE when ~/.aws exists', async () => {
      mockSuccessfulPrepare();

      const server = new ContainerDevServer(defaultConfig, defaultOptions);
      await server.start();

      const spawnArgs = getSpawnArgs();
      expect(spawnArgs).toContain('AWS_CONFIG_FILE=/aws-config/config');
      expect(spawnArgs).toContain('AWS_SHARED_CREDENTIALS_FILE=/aws-config/credentials');
    });
    it('skips ~/.aws mount when directory does not exist', async () => {
      mockDetectContainerRuntime.mockResolvedValue({
        runtime: { runtime: 'docker', binary: 'docker', version: 'Docker 24.0' },
      });
      // existsSync is called for: (1) Dockerfile in prepare(), (2) ~/.aws in getSpawnConfig()
      mockExistsSync.mockImplementation((path: string) => {
        if (typeof path === 'string' && path.includes('.aws')) return false;
        return true; // Dockerfile exists
      });
      mockSpawnSync.mockReturnValue({ status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') });
      const mockBuild = createMockBuildProcess(0);
      const mockChild = createMockChildProcess();
      mockSpawn.mockReturnValueOnce(mockBuild).mockReturnValueOnce(mockChild);

      const server = new ContainerDevServer(defaultConfig, defaultOptions);
      await server.start();

      const spawnArgs = getSpawnArgs();
      const awsMountArg = spawnArgs.find((arg: string) => arg.includes('.aws'));
      expect(awsMountArg).toBeUndefined();
    });

    it('does not include uvicorn or reload args', async () => {
      mockSuccessfulPrepare();

      const server = new ContainerDevServer(defaultConfig, defaultOptions);
      await server.start();

      const spawnArgs = getSpawnArgs();
      expect(spawnArgs).not.toContain('uvicorn');
      expect(spawnArgs).not.toContain('--reload');
      expect(spawnArgs).not.toContain('-m');
    });
  });

  describe('kill()', () => {
    it('stops container using docker stop before calling super.kill()', async () => {
      mockSuccessfulPrepare();

      const server = new ContainerDevServer(defaultConfig, defaultOptions);
      const child = await server.start();

      // Clear mocks to isolate the kill call
      mockSpawn.mockClear();

      server.kill();

      // Container stop is async (spawn not spawnSync) so UI can render "Stopping..." message
      expect(mockSpawn).toHaveBeenCalledWith('docker', ['stop', 'agentcore-dev-testagent'], { stdio: 'ignore' });
      expect(child!.kill).toHaveBeenCalledWith('SIGTERM'); // eslint-disable-line @typescript-eslint/unbound-method
    });

    it('does not call container stop when runtimeBinary is empty (prepare not called)', () => {
      const server = new ContainerDevServer(defaultConfig, defaultOptions);
      mockSpawn.mockClear();

      server.kill();

      expect(mockSpawn).not.toHaveBeenCalled();
    });
  });
});
