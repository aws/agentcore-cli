import { CodeZipDevServer } from '../codezip-dev-server';
import type { DevConfig } from '../config';
import type { DevServerCallbacks, DevServerOptions } from '../dev-server';
import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSpawn = vi.fn();
vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  spawnSync: vi.fn(() => ({ status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') })),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
}));

vi.mock('../../../../lib/utils/platform', () => ({
  getVenvExecutable: (venvPath: string, executable: string) => `${venvPath}/bin/${executable}`,
}));

function createMockChildProcess() {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = vi.fn();
  return proc;
}

const mockCallbacks: DevServerCallbacks = { onLog: vi.fn(), onExit: vi.fn() };
const defaultOptions: DevServerOptions = { port: 8080, envVars: { MY_KEY: 'secret' }, callbacks: mockCallbacks };

describe('CodeZipDevServer spawn config', () => {
  beforeEach(() => {
    mockSpawn.mockReturnValue(createMockChildProcess());
  });

  it('HTTP: uses uvicorn with --reload', async () => {
    const config: DevConfig = {
      agentName: 'HttpAgent',
      module: 'main.py',
      directory: '/project/app',
      hasConfig: true,
      isPython: true,
      buildType: 'CodeZip',
      protocol: 'HTTP',
    };

    const server = new CodeZipDevServer(config, defaultOptions);
    await server.start();

    expect(mockSpawn).toHaveBeenCalledWith(
      '/project/app/.venv/bin/uvicorn',
      expect.arrayContaining(['--reload', '--host', '127.0.0.1', '--port', '8080']),
      expect.objectContaining({ cwd: '/project/app' })
    );
  });

  it('MCP: uses python directly with main.py', async () => {
    const config: DevConfig = {
      agentName: 'McpAgent',
      module: 'main.py',
      directory: '/project/app',
      hasConfig: true,
      isPython: true,
      buildType: 'CodeZip',
      protocol: 'MCP',
    };

    const server = new CodeZipDevServer(config, defaultOptions);
    await server.start();

    expect(mockSpawn).toHaveBeenCalledWith(
      '/project/app/.venv/bin/python',
      ['main.py'],
      expect.objectContaining({ cwd: '/project/app' })
    );
  });

  it('A2A: uses python directly with main.py', async () => {
    const config: DevConfig = {
      agentName: 'A2aAgent',
      module: 'main.py',
      directory: '/project/app',
      hasConfig: true,
      isPython: true,
      buildType: 'CodeZip',
      protocol: 'A2A',
    };

    const server = new CodeZipDevServer(config, defaultOptions);
    await server.start();

    expect(mockSpawn).toHaveBeenCalledWith(
      '/project/app/.venv/bin/python',
      ['main.py'],
      expect.objectContaining({ cwd: '/project/app' })
    );
  });

  it('non-HTTP: passes env vars including PORT and LOCAL_DEV', async () => {
    const config: DevConfig = {
      agentName: 'A2aAgent',
      module: 'main.py',
      directory: '/project/app',
      hasConfig: true,
      isPython: true,
      buildType: 'CodeZip',
      protocol: 'A2A',
    };

    const server = new CodeZipDevServer(config, defaultOptions);
    await server.start();

    const spawnCall = mockSpawn.mock.calls[0]!;
    const env = spawnCall[2].env;
    expect(env.PORT).toBe('8080');
    expect(env.LOCAL_DEV).toBe('1');
    expect(env.MY_KEY).toBe('secret');
  });

  it('MCP: extracts file from module:function entrypoint', async () => {
    const config: DevConfig = {
      agentName: 'McpAgent',
      module: 'app.py:handler',
      directory: '/project/app',
      hasConfig: true,
      isPython: true,
      buildType: 'CodeZip',
      protocol: 'MCP',
    };

    const server = new CodeZipDevServer(config, defaultOptions);
    await server.start();

    expect(mockSpawn).toHaveBeenCalledWith(
      '/project/app/.venv/bin/python',
      ['app.py'],
      expect.objectContaining({ cwd: '/project/app' })
    );
  });
});
