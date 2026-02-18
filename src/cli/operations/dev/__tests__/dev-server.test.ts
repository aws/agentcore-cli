import type { DevConfig } from '../config.js';
import { DevServer, type DevServerCallbacks, type DevServerOptions, type SpawnConfig } from '../dev-server.js';
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSpawn = vi.fn();
vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

function createMockChildProcess() {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = vi.fn();
  return proc;
}

class TestDevServer extends DevServer {
  public prepareResult = true;
  public spawnConfig: SpawnConfig = {
    cmd: 'test-cmd',
    args: ['--flag'],
    cwd: '/test',
    env: { PATH: '/usr/bin' },
  };

  protected prepare(): Promise<boolean> {
    return Promise.resolve(this.prepareResult);
  }

  protected getSpawnConfig(): SpawnConfig {
    return this.spawnConfig;
  }
}

const config: DevConfig = {
  agentName: 'TestAgent',
  module: 'main.py',
  directory: '/test',
  hasConfig: true,
  isPython: true,
  buildType: 'CodeZip',
};

describe('DevServer', () => {
  let onLog: DevServerCallbacks['onLog'];
  let onExit: DevServerCallbacks['onExit'];
  let callbacks: DevServerCallbacks;
  let options: DevServerOptions;
  let server: TestDevServer;
  let mockChild: ReturnType<typeof createMockChildProcess>;

  beforeEach(() => {
    onLog = vi.fn<DevServerCallbacks['onLog']>();
    onExit = vi.fn<DevServerCallbacks['onExit']>();
    callbacks = { onLog, onExit };
    options = { port: 8080, callbacks };
    server = new TestDevServer(config, options);
    mockChild = createMockChildProcess();
    mockSpawn.mockReturnValue(mockChild);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('start()', () => {
    it('calls spawn with correct cmd, args, cwd, env, and stdio when prepare succeeds', async () => {
      await server.start();

      expect(mockSpawn).toHaveBeenCalledWith('test-cmd', ['--flag'], {
        cwd: '/test',
        env: { PATH: '/usr/bin' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    });

    it('returns child process on success', async () => {
      const result = await server.start();
      expect(result).toBe(mockChild);
    });

    it('returns null and calls onExit(1) when prepare fails', async () => {
      server.prepareResult = false;
      const result = await server.start();

      expect(result).toBeNull();
      expect(onExit).toHaveBeenCalledWith(1);
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('passes stdio as ["ignore", "pipe", "pipe"]', async () => {
      await server.start();

      const spawnOptions = mockSpawn.mock.calls[0]![2] as { stdio: string[] };
      expect(spawnOptions.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    });
  });

  describe('kill()', () => {
    it('does nothing when no child process (no start called)', () => {
      // Should not throw
      server.kill();
    });

    it('does nothing when child already killed', async () => {
      await server.start();
      mockChild.killed = true;

      server.kill();
      expect(mockChild.kill).not.toHaveBeenCalled();
    });

    it('sends SIGTERM first', async () => {
      await server.start();

      server.kill();
      expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('sends SIGKILL after 2s if not killed', async () => {
      vi.useFakeTimers();

      await server.start();
      server.kill();

      expect(mockChild.kill).toHaveBeenCalledTimes(1);
      expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');

      vi.advanceTimersByTime(2000);

      expect(mockChild.kill).toHaveBeenCalledTimes(2);
      expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL');

      vi.useRealTimers();
    });

    it('does not send SIGKILL if process already dead after SIGTERM', async () => {
      vi.useFakeTimers();

      await server.start();
      server.kill();

      // Simulate process dying after SIGTERM
      mockChild.killed = true;

      vi.advanceTimersByTime(2000);

      expect(mockChild.kill).toHaveBeenCalledTimes(1);
      expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');

      vi.useRealTimers();
    });
  });

  describe('output routing', () => {
    it('forwards stdout lines to onLog at info level', async () => {
      await server.start();

      mockChild.stdout.emit('data', Buffer.from('hello world'));
      expect(onLog).toHaveBeenCalledWith('info', 'hello world');
    });

    it('splits multi-line stdout into separate onLog calls', async () => {
      await server.start();

      mockChild.stdout.emit('data', Buffer.from('line1\nline2\nline3'));

      expect(onLog).toHaveBeenCalledTimes(3);
      expect(onLog).toHaveBeenCalledWith('info', 'line1');
      expect(onLog).toHaveBeenCalledWith('info', 'line2');
      expect(onLog).toHaveBeenCalledWith('info', 'line3');
    });

    it('ignores empty stdout data', async () => {
      await server.start();

      mockChild.stdout.emit('data', Buffer.from('   \n  \n  '));
      expect(onLog).not.toHaveBeenCalled();
    });

    it('classifies stderr "warning" as warn level', async () => {
      await server.start();

      mockChild.stderr.emit('data', Buffer.from('DeprecationWarning: something old'));
      expect(onLog).toHaveBeenCalledWith('warn', 'DeprecationWarning: something old');
    });

    it('classifies stderr "error" as error level', async () => {
      await server.start();

      mockChild.stderr.emit('data', Buffer.from('RuntimeError: something broke'));
      expect(onLog).toHaveBeenCalledWith('error', 'RuntimeError: something broke');
    });

    it('classifies other stderr as info level', async () => {
      await server.start();

      mockChild.stderr.emit('data', Buffer.from('some debug info'));
      expect(onLog).toHaveBeenCalledWith('info', 'some debug info');
    });

    it('handles process error event', async () => {
      await server.start();

      mockChild.emit('error', new Error('spawn failed'));

      expect(onLog).toHaveBeenCalledWith('error', 'Failed to start: spawn failed');
      expect(onExit).toHaveBeenCalledWith(1);
    });

    it('handles process exit event', async () => {
      await server.start();

      mockChild.emit('exit', 0);
      expect(onExit).toHaveBeenCalledWith(0);
    });
  });
});
