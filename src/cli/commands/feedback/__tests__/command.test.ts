import { TelemetryClient } from '../../../telemetry/client';
import { TelemetryClientAccessor } from '../../../telemetry/client-accessor';
import { InMemorySink } from '../../../telemetry/sinks/in-memory-sink';
import { registerFeedback } from '../command';
import { Command } from '@commander-js/extra-typings';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockHandleFeedback = vi.fn();
const mockRender = vi.fn();
const mockRequireTTY = vi.fn();

vi.mock('../action', () => ({
  handleFeedback: (...args: unknown[]) => mockHandleFeedback(...args),
}));

vi.mock('../../../tui/guards/tty', () => ({
  requireTTY: () => mockRequireTTY(),
}));

vi.mock('../../../tui/screens/feedback', () => ({
  FeedbackScreen: () => null,
}));

vi.mock('ink', () => ({
  render: (...args: unknown[]) => {
    mockRender(...args);
    return {
      clear: vi.fn(),
      unmount: vi.fn(),
      waitUntilExit: () => Promise.resolve(),
    };
  },
  Text: 'Text',
  Box: 'Box',
}));

const submittedOutcome = {
  kind: 'submitted' as const,
  result: { id: 'sub-1', timestamp: '2026-05-13T18:00:00Z', reference: 'S3' },
};

describe('registerFeedback', () => {
  let program: Command;
  let sink: InMemorySink;
  let mockExit: ReturnType<typeof vi.spyOn>;
  let mockLog: ReturnType<typeof vi.spyOn>;
  let mockError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerFeedback(program);

    sink = new InMemorySink();
    vi.spyOn(TelemetryClientAccessor, 'get').mockResolvedValue(new TelemetryClient(sink));

    mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
    mockLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    mockError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('registers a top-level feedback command', () => {
    const cmd = program.commands.find(c => c.name() === 'feedback');
    expect(cmd).toBeDefined();
  });

  it('emits success JSON when --json is supplied with a message', async () => {
    mockHandleFeedback.mockResolvedValue(submittedOutcome);

    await expect(program.parseAsync(['feedback', 'looks good', '--json'], { from: 'user' })).rejects.toThrow(
      'process.exit'
    );

    expect(mockHandleFeedback).toHaveBeenCalledWith('looks good', expect.objectContaining({ json: true }));
    expect(mockExit).toHaveBeenCalledWith(0);
    const output = JSON.parse(mockLog.mock.calls[0]?.[0] as string);
    expect(output).toEqual({
      success: true,
      id: 'sub-1',
      timestamp: '2026-05-13T18:00:00Z',
      reference: 'S3',
    });

    expect(sink.metrics).toHaveLength(1);
    expect(sink.metrics[0]!.attrs).toMatchObject({
      command: 'feedback',
      exit_reason: 'success',
      mode: 'cli',
      has_screenshot: 'false',
    });
  });

  it('reports a TTY error when consent cannot be confirmed and exits 1', async () => {
    mockHandleFeedback.mockResolvedValue({ kind: 'no-tty' });

    await expect(program.parseAsync(['feedback', 'msg'], { from: 'user' })).rejects.toThrow('process.exit');

    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('consent must be confirmed interactively'));
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('prints a friendly cancellation message when the user declines consent', async () => {
    mockHandleFeedback.mockResolvedValue({ kind: 'declined' });

    await expect(program.parseAsync(['feedback', 'msg'], { from: 'user' })).rejects.toThrow('process.exit');

    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('Feedback cancelled.'));
    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it('reports submission errors with exit 1 in plain mode', async () => {
    mockHandleFeedback.mockResolvedValue({ kind: 'error', error: 'HTTP 500' });

    await expect(program.parseAsync(['feedback', 'msg'], { from: 'user' })).rejects.toThrow('process.exit');

    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('HTTP 500'));

    expect(sink.metrics).toHaveLength(1);
    expect(sink.metrics[0]!.attrs).toMatchObject({
      command: 'feedback',
      exit_reason: 'failure',
      mode: 'cli',
      has_screenshot: 'false',
    });
  });

  it('emits a JSON error envelope on submission failure when --json is set', async () => {
    mockHandleFeedback.mockResolvedValue({ kind: 'error', error: 'HTTP 500' });

    await expect(program.parseAsync(['feedback', 'msg', '--json'], { from: 'user' })).rejects.toThrow('process.exit');

    const output = JSON.parse(mockLog.mock.calls[0]?.[0] as string);
    expect(output).toEqual({ success: false, error: 'HTTP 500' });
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('refuses --json when no message is supplied', async () => {
    await expect(program.parseAsync(['feedback', '--json'], { from: 'user' })).rejects.toThrow('process.exit');

    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('--json requires a feedback message'));
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockHandleFeedback).not.toHaveBeenCalled();
  });

  it('hands off to the TUI when no message argument is provided, then exits cleanly', async () => {
    await expect(program.parseAsync(['feedback'], { from: 'user' })).rejects.toThrow('process.exit');

    expect(mockRequireTTY).toHaveBeenCalled();
    expect(mockRender).toHaveBeenCalled();
    expect(mockHandleFeedback).not.toHaveBeenCalled();
    // After the wizard unmounts we must terminate the Node process; otherwise
    // Ink's stdin raw-mode listeners keep the process alive.
    expect(mockExit).toHaveBeenCalledWith(0);
  });
});
