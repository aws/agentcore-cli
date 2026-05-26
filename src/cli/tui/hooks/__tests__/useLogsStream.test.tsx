import type { AgentContext } from '../../../commands/logs/action.js';
import { useLogsStream } from '../useLogsStream.js';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockStreamLogs } = vi.hoisted(() => ({
  mockStreamLogs: vi.fn(),
}));

vi.mock('../../../aws/cloudwatch.js', () => ({
  streamLogs: mockStreamLogs,
}));

const AGENT_CONTEXT: AgentContext = {
  agentId: 'test-runtime-id',
  agentName: 'TestAgent',
  accountId: '123456789012',
  region: 'us-east-1',
  endpointName: 'default',
  logGroupName: '/aws/bedrock-agentcore/runtimes/test-runtime-id-default',
};

function Harness({ agentContext }: { agentContext: AgentContext | undefined }) {
  const { logs, isStreaming, error } = useLogsStream(agentContext);
  return (
    <Text>
      streaming:{String(isStreaming)} logs:{logs.length} error:{error ?? 'null'}
    </Text>
  );
}

describe('useLogsStream', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('stays idle when agentContext is undefined', () => {
    // eslint-disable-next-line require-yield
    mockStreamLogs.mockImplementation(async function* () {
      await Promise.resolve();
    });

    const { lastFrame } = render(<Harness agentContext={undefined} />);

    expect(lastFrame()).toContain('streaming:false');
    expect(lastFrame()).toContain('logs:0');
    expect(lastFrame()).toContain('error:null');
    expect(mockStreamLogs).not.toHaveBeenCalled();
  });

  it('transitions to streaming and appends log entries', async () => {
    let resolve: () => void;
    const done = new Promise<void>(r => {
      resolve = r;
    });

    mockStreamLogs.mockImplementation(async function* () {
      await Promise.resolve();
      yield { timestamp: 1000, message: 'hello world' };
      yield { timestamp: 2000, message: '[ERROR] something broke' };
      resolve!();
    });

    const { lastFrame } = render(<Harness agentContext={AGENT_CONTEXT} />);

    await done;
    await new Promise(r => setTimeout(r, 50));

    const frame = lastFrame();
    expect(frame).toContain('logs:2');
  });

  it('detects error level from message content', async () => {
    let resolve: () => void;
    const done = new Promise<void>(r => {
      resolve = r;
    });

    mockStreamLogs.mockImplementation(async function* () {
      await Promise.resolve();
      yield { timestamp: 1000, message: '[error] bad thing' };
      resolve!();
    });

    const { lastFrame } = render(<Harness agentContext={AGENT_CONTEXT} />);
    await done;
    await new Promise(r => setTimeout(r, 50));

    expect(lastFrame()).toContain('logs:1');
  });

  it('shows friendly message for ResourceNotFoundException', async () => {
    // eslint-disable-next-line require-yield
    mockStreamLogs.mockImplementation(async function* () {
      await Promise.resolve();
      const err = new Error('Not found');
      err.name = 'ResourceNotFoundException';
      throw err;
    });

    const { lastFrame } = render(<Harness agentContext={AGENT_CONTEXT} />);
    await new Promise(r => setTimeout(r, 50));

    const frame = lastFrame();
    expect(frame).toContain('error:No logs found');
    expect(frame).toContain('Has the agent been invoked?');
    expect(frame).toContain('streaming:false');
  });

  it('shows generic error message for other errors', async () => {
    // eslint-disable-next-line require-yield
    mockStreamLogs.mockImplementation(async function* () {
      await Promise.resolve();
      throw new Error('Connection refused');
    });

    const { lastFrame } = render(<Harness agentContext={AGENT_CONTEXT} />);
    await new Promise(r => setTimeout(r, 50));

    const frame = lastFrame();
    expect(frame).toContain('error:Connection refused');
    expect(frame).toContain('streaming:false');
  });

  it('does not surface abort errors when unmounted', async () => {
    // eslint-disable-next-line require-yield
    mockStreamLogs.mockImplementation(async function* ({ abortSignal }: { abortSignal: AbortSignal }) {
      await new Promise((_, reject) => {
        abortSignal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    });

    const { lastFrame, unmount } = render(<Harness agentContext={AGENT_CONTEXT} />);
    await new Promise(r => setTimeout(r, 50));

    expect(lastFrame()).toContain('streaming:true');

    unmount();
    await new Promise(r => setTimeout(r, 50));
  });

  it('caps log buffer at 1000 entries', async () => {
    let resolve: () => void;
    const done = new Promise<void>(r => {
      resolve = r;
    });

    mockStreamLogs.mockImplementation(async function* () {
      await Promise.resolve();
      for (let i = 0; i < 1050; i++) {
        yield { timestamp: i, message: `log ${i}` };
      }
      resolve!();
    });

    const { lastFrame } = render(<Harness agentContext={AGENT_CONTEXT} />);
    await done;
    await new Promise(r => setTimeout(r, 100));

    const frame = lastFrame();
    expect(frame).toContain('logs:1000');
  });
});
