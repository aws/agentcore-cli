import { runWebUI } from '../run-web-ui';
import type { WebUIOptions } from '../web-server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  loggerLog: vi.fn(),
  loggerFinalize: vi.fn(),
  consumerLog: vi.fn(),
  serverOptions: undefined as WebUIOptions | undefined,
}));

vi.mock('../../../../logging', () => ({
  ExecLogger: class {
    log = state.loggerLog;
    finalize = state.loggerFinalize;

    getRelativeLogPath() {
      return '.cli/logs/dev/test.log';
    }
  },
}));

vi.mock('../../server', () => ({
  findAvailablePort: vi.fn().mockResolvedValue(8081),
}));

vi.mock('../../utils', () => ({
  onShutdownSignal: vi.fn(),
  openBrowser: vi.fn(),
}));

vi.mock('../web-server', () => ({
  WebUIServer: class {
    constructor(options: WebUIOptions) {
      state.serverOptions = options;
    }

    start = vi.fn();
    stop = vi.fn();
  },
}));

describe('runWebUI logging', () => {
  beforeEach(() => {
    state.loggerLog.mockClear();
    state.loggerFinalize.mockClear();
    state.consumerLog.mockClear();
    state.serverOptions = undefined;
  });

  it('writes web UI messages to the advertised log and the display handler', async () => {
    void runWebUI({
      logLabel: 'dev',
      onLog: state.consumerLog,
      serverOptions: {
        mode: 'dev',
        agents: [],
      },
    });

    await vi.waitFor(() => expect(state.serverOptions).toBeDefined());
    state.serverOptions!.onLog!('error', 'Failed to install Node dependencies: spawn npm ENOENT');

    expect(state.loggerLog).toHaveBeenCalledWith('Failed to install Node dependencies: spawn npm ENOENT', 'error');
    expect(state.consumerLog).toHaveBeenCalledWith('error', 'Failed to install Node dependencies: spawn npm ENOENT');
  });
});
