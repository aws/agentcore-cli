import { invokeA2ARuntime } from '../agentcore.js';
import type { A2AInvokeOptions } from '../agentcore.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the SDK so the SigV4 path doesn't need real credentials
const mockSdkSend = vi.fn();
vi.mock('@aws-sdk/client-bedrock-agentcore', () => {
  class MockBedrockAgentCoreClient {
    send = mockSdkSend;
    middlewareStack = { add: vi.fn() };
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    constructor(_config: unknown) {}
  }
  return {
    BedrockAgentCoreClient: MockBedrockAgentCoreClient,
    InvokeAgentRuntimeCommand: vi.fn(),
    StopRuntimeSessionCommand: vi.fn(),
    EvaluateCommand: vi.fn(),
  };
});

vi.mock('../account.js', () => ({
  getCredentialProvider: vi
    .fn()
    .mockReturnValue(() => Promise.resolve({ accessKeyId: 'test', secretAccessKey: 'test' })),
}));

const a2aResultBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  result: { artifacts: [{ parts: [{ kind: 'text', text: 'Hello from A2A' }] }] },
});

const baseOpts: A2AInvokeOptions = {
  region: 'us-east-1',
  runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789:runtime/test-runtime',
  userId: 'test-user',
};

async function drain(stream: AsyncGenerator<string, void, unknown>): Promise<string> {
  let out = '';
  for await (const chunk of stream) out += chunk;
  return out;
}

describe('invokeA2ARuntime bearer-token auth path', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let capturedRequests: { url: string; init: RequestInit }[];

  beforeEach(() => {
    capturedRequests = [];
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      capturedRequests.push({ url: input as string, init: init! });
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(a2aResultBody),
        headers: { get: () => null },
      } as unknown as Response);
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('uses fetch with Bearer Authorization header and never the SigV4 client', async () => {
    const result = await invokeA2ARuntime({ ...baseOpts, bearerToken: 'test-jwt-token' }, 'hi');
    const text = await drain(result.stream);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(mockSdkSend).not.toHaveBeenCalled();

    const headers = capturedRequests[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-jwt-token');

    // JSON-RPC message/send body is carried in the fetch payload
    const body = JSON.parse(capturedRequests[0]!.init.body as string);
    expect(body.method).toBe('message/send');
    expect(body.params.message.parts[0].text).toBe('hi');

    // Response is still routed through parseA2AResponse
    expect(text).toBe('Hello from A2A');
  });

  it('falls back to the SigV4 client when no bearerToken is supplied', async () => {
    mockSdkSend.mockResolvedValue({
      response: { transformToByteArray: () => Promise.resolve(new TextEncoder().encode(a2aResultBody)) },
    });

    await invokeA2ARuntime(baseOpts, 'hi');

    expect(mockSdkSend).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
