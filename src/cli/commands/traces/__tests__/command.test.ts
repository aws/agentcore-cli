import { registerTraces } from '../command.js';
import { Command } from '@commander-js/extra-typings';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetProjectRootMismatch,
  mockHandleTracesCompare,
  mockHandleTracesGet,
  mockHandleTracesList,
  mockLoadConfig,
  mockProjectExists,
  mockRender,
  mockRequireProject,
} = vi.hoisted(() => ({
  mockGetProjectRootMismatch: vi.fn(),
  mockHandleTracesCompare: vi.fn(),
  mockHandleTracesGet: vi.fn(),
  mockHandleTracesList: vi.fn(),
  mockLoadConfig: vi.fn(),
  mockProjectExists: vi.fn(),
  mockRender: vi.fn(),
  mockRequireProject: vi.fn(),
}));

vi.mock('../action', () => ({
  handleTracesCompare: (...args: unknown[]) => mockHandleTracesCompare(...args),
  handleTracesGet: (...args: unknown[]) => mockHandleTracesGet(...args),
  handleTracesList: (...args: unknown[]) => mockHandleTracesList(...args),
}));

vi.mock('../../../telemetry/cli-command-run.js', () => ({
  withCommandRunTelemetry: vi.fn((_command: unknown, _attrs: unknown, run: () => unknown) => run()),
}));

vi.mock('../../../operations/resolve-agent', () => ({
  loadDeployedProjectConfig: () => mockLoadConfig(),
}));

vi.mock('../../../tui/guards', () => ({
  getProjectRootMismatch: () => mockGetProjectRootMismatch(),
  projectExists: () => mockProjectExists(),
  requireProject: () => mockRequireProject(),
}));

vi.mock('ink', () => ({
  Box: 'Box',
  Text: 'Text',
  render: (...args: unknown[]) => mockRender(...args),
}));

describe('traces JSON output', () => {
  let program: Command;
  let mockExit: ReturnType<typeof vi.spyOn>;
  let mockLog: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerTraces(program);

    mockLoadConfig.mockResolvedValue({ project: {}, deployment: {} });
    mockProjectExists.mockReturnValue(true);
    mockGetProjectRootMismatch.mockReturnValue(null);
    mockExit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    mockLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('emits trace list results as JSON', async () => {
    mockHandleTracesList.mockResolvedValue({
      success: true,
      agentName: 'runtime-one',
      targetName: 'default',
      traces: [{ traceId: 'trace-1', timestamp: '1700000000000', sessionId: 'session-1' }],
    });

    await program.parseAsync(['traces', 'list', '--runtime', 'runtime-one', '--json'], { from: 'user' });

    expect(JSON.parse(mockLog.mock.calls[0]![0])).toEqual({
      success: true,
      agentName: 'runtime-one',
      targetName: 'default',
      traces: [{ traceId: 'trace-1', timestamp: '1700000000000', sessionId: 'session-1' }],
    });
    expect(mockHandleTracesList).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ runtime: 'runtime-one', json: true })
    );
    expect(mockRender).not.toHaveBeenCalled();
  });

  it('emits trace get results as JSON', async () => {
    mockHandleTracesGet.mockResolvedValue({
      success: true,
      agentName: 'runtime-one',
      targetName: 'default',
      filePath: '/tmp/trace-1.json',
    });

    await program.parseAsync(['traces', 'get', 'trace-1', '--runtime', 'runtime-one', '--json'], { from: 'user' });

    expect(JSON.parse(mockLog.mock.calls[0]![0])).toEqual({
      success: true,
      agentName: 'runtime-one',
      targetName: 'default',
      filePath: '/tmp/trace-1.json',
    });
    expect(mockHandleTracesGet).toHaveBeenCalledWith(
      expect.anything(),
      'trace-1',
      expect.objectContaining({ runtime: 'runtime-one', json: true })
    );
    expect(mockRender).not.toHaveBeenCalled();
  });

  it('emits typed failures as JSON and exits 1', async () => {
    mockHandleTracesList.mockResolvedValue({
      success: false,
      error: new Error('Runtime not found'),
      consoleUrl: 'https://console.aws.amazon.com/example',
    });

    await program.parseAsync(['traces', 'list', '--json'], { from: 'user' });

    expect(JSON.parse(mockLog.mock.calls[0]![0])).toEqual({
      success: false,
      error: 'Runtime not found',
      consoleUrl: 'https://console.aws.amazon.com/example',
    });
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockRender).not.toHaveBeenCalled();
  });

  it('emits thrown errors as JSON and exits 1', async () => {
    mockLoadConfig.mockRejectedValue(new Error('Invalid project configuration'));

    await program.parseAsync(['traces', 'get', 'trace-1', '--json'], { from: 'user' });

    expect(JSON.parse(mockLog.mock.calls[0]![0])).toEqual({
      success: false,
      error: 'Invalid project configuration',
    });
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockRender).not.toHaveBeenCalled();
  });

  it('emits a JSON error when run outside a project', async () => {
    mockProjectExists.mockReturnValue(false);

    await program.parseAsync(['traces', 'list', '--json'], { from: 'user' });

    expect(JSON.parse(mockLog.mock.calls[0]![0])).toEqual({
      success: false,
      error: 'No agentcore project found. Run agentcore create first.',
    });
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockLoadConfig).not.toHaveBeenCalled();
    expect(mockRender).not.toHaveBeenCalled();
  });

  it('emits trace compare results as JSON', async () => {
    const baseline = { traceId: 'trace-1', spanCount: 3, endToEndMs: 6600, timingSource: 'invocation-span' };
    const candidate = { traceId: 'trace-2', spanCount: 3, endToEndMs: 5120, timingSource: 'invocation-span' };
    mockHandleTracesCompare.mockResolvedValue({
      success: true,
      agentName: 'runtime-one',
      targetName: 'default',
      baseline,
      candidate,
      deltas: { endToEndMs: { baseline: 6600, candidate: 5120, delta: -1480, deltaPercent: -22.4 } },
      warnings: [],
    });

    await program.parseAsync(['traces', 'compare', 'trace-1', 'trace-2', '--runtime', 'runtime-one', '--json'], {
      from: 'user',
    });

    expect(JSON.parse(mockLog.mock.calls[0]![0])).toEqual({
      success: true,
      agentName: 'runtime-one',
      targetName: 'default',
      baseline,
      candidate,
      deltas: { endToEndMs: { baseline: 6600, candidate: 5120, delta: -1480, deltaPercent: -22.4 } },
      warnings: [],
    });
    expect(mockHandleTracesCompare).toHaveBeenCalledWith(
      expect.anything(),
      'trace-1',
      'trace-2',
      expect.objectContaining({ runtime: 'runtime-one', json: true })
    );
    expect(mockRender).not.toHaveBeenCalled();
  });

  it('emits trace compare failures as JSON and exits 1', async () => {
    mockHandleTracesCompare.mockResolvedValue({
      success: false,
      error: new Error('No spans found for baseline trace trace-1'),
    });

    await program.parseAsync(['traces', 'compare', 'trace-1', 'trace-2', '--json'], { from: 'user' });

    expect(JSON.parse(mockLog.mock.calls[0]![0])).toEqual({
      success: false,
      error: 'No spans found for baseline trace trace-1',
    });
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockRender).not.toHaveBeenCalled();
  });

  it('renders trace compare output with Ink for non-JSON runs', async () => {
    mockHandleTracesCompare.mockResolvedValue({
      success: true,
      agentName: 'runtime-one',
      targetName: 'default',
      baseline: { traceId: 'trace-1', spanCount: 3, endToEndMs: 6600, timingSource: 'invocation-span' },
      candidate: { traceId: 'trace-2', spanCount: 3, endToEndMs: 5120, timingSource: 'invocation-span' },
      deltas: {
        endToEndMs: { baseline: 6600, candidate: 5120, delta: -1480, deltaPercent: -22.4 },
        llmMs: { baseline: 3620, candidate: 3040, delta: -580, deltaPercent: -16.0 },
        toolMs: { baseline: 2850, candidate: 1710, delta: -1140, deltaPercent: -40.0 },
        llmCalls: { baseline: 2, candidate: 2, delta: 0, deltaPercent: 0 },
        toolCalls: { baseline: 1, candidate: 1, delta: 0, deltaPercent: 0 },
        inputTokens: { baseline: 2849, candidate: 1912, delta: -937, deltaPercent: -32.9 },
        outputTokens: { baseline: 315, candidate: 237, delta: -78, deltaPercent: -24.8 },
        totalTokens: {},
      },
      warnings: ['LLM call counts differ (baseline 1, candidate 2); traces may not be directly comparable'],
    });

    await program.parseAsync(['traces', 'compare', 'trace-1', 'trace-2'], { from: 'user' });

    expect(mockRender).toHaveBeenCalledOnce();
    expect(mockLog).not.toHaveBeenCalled();
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('keeps Ink rendering for non-JSON output', async () => {
    mockHandleTracesGet.mockResolvedValue({
      success: true,
      filePath: '/tmp/trace-1.json',
    });

    await program.parseAsync(['traces', 'get', 'trace-1'], { from: 'user' });

    expect(mockRender).toHaveBeenCalledOnce();
    expect(mockLog).not.toHaveBeenCalled();
    expect(mockExit).not.toHaveBeenCalled();
  });
});
