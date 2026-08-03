import type { InvokeContext } from '../action';
import { handleInvoke } from '../action';
import type { InvokeOptions } from '../types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockResolveInvokeTarget = vi.fn();
const mockInvokeA2ARuntime = vi.fn();
const mockInvokeA2ARuntimeStreaming = vi.fn();

vi.mock('../resolve', () => ({
  resolveInvokeTarget: (...args: unknown[]) => mockResolveInvokeTarget(...args),
}));

vi.mock('../../../aws', () => ({
  DEFAULT_RUNTIME_USER_ID: 'default-user',
  buildAguiRunInput: vi.fn(),
  executeBashCommand: vi.fn(),
  extractResult: vi.fn(),
  getOrCreatePaymentSession: vi.fn(),
  invokeA2ARuntime: (...args: unknown[]) => mockInvokeA2ARuntime(...args),
  invokeA2ARuntimeStreaming: (...args: unknown[]) => mockInvokeA2ARuntimeStreaming(...args),
  invokeAgentRuntime: vi.fn(),
  invokeAgentRuntimeStreaming: vi.fn(),
  invokeAguiRuntime: vi.fn(),
  mcpCallTool: vi.fn(),
  mcpInitSession: vi.fn(),
  mcpListTools: vi.fn(),
  parseSSE: vi.fn(),
}));

function resolvedA2A(): Record<string, unknown> {
  return {
    success: true,
    agentSpec: { name: 'A2AAgent', protocol: 'A2A' },
    targetName: 'default',
    targetConfig: { name: 'default', region: 'us-east-1' },
    region: 'us-east-1',
    runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r',
    baggage: undefined,
  };
}

function makeContext(): InvokeContext {
  return {
    project: { name: 'p', runtimes: [{ name: 'A2AAgent', protocol: 'A2A' }] } as never,
    deployedState: { targets: { default: { resources: {} } } } as never,
    awsTargets: [{ name: 'default', region: 'us-east-1' }] as never,
  };
}

// eslint-disable-next-line @typescript-eslint/require-await
async function* streamOf(text: string): AsyncGenerator<string, void, unknown> {
  yield text;
}

describe('handleInvoke — A2A stream routing', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockResolveInvokeTarget.mockResolvedValue(resolvedA2A());
    mockInvokeA2ARuntime.mockResolvedValue({ stream: streamOf('non-stream path'), sessionId: undefined });
    mockInvokeA2ARuntimeStreaming.mockResolvedValue({ stream: streamOf('stream path'), sessionId: undefined });
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.clearAllMocks();
    stdoutSpy.mockRestore();
  });

  it('routes --stream to invokeA2ARuntimeStreaming for A2A agents', async () => {
    const options: InvokeOptions = { prompt: 'hello', stream: true };
    const result = await handleInvoke(makeContext(), options);

    expect(result.success).toBe(true);
    expect(mockInvokeA2ARuntimeStreaming).toHaveBeenCalledTimes(1);
    expect(mockInvokeA2ARuntime).not.toHaveBeenCalled();
    expect(mockInvokeA2ARuntimeStreaming).toHaveBeenCalledWith(
      expect.objectContaining({
        region: 'us-east-1',
        runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r',
      }),
      'hello'
    );
  });

  it('routes non-stream invokes to invokeA2ARuntime for A2A agents', async () => {
    const options: InvokeOptions = { prompt: 'hello', stream: false };
    const result = await handleInvoke(makeContext(), options);

    expect(result.success).toBe(true);
    expect(mockInvokeA2ARuntime).toHaveBeenCalledTimes(1);
    expect(mockInvokeA2ARuntimeStreaming).not.toHaveBeenCalled();
    expect(mockInvokeA2ARuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        region: 'us-east-1',
        runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r',
      }),
      'hello'
    );
  });
});
