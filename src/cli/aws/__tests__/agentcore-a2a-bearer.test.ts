import { invokeA2ARuntime, invokeA2ARuntimeStreaming } from '../agentcore.js';
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

// ---------------------------------------------------------------------------
// Shared helpers for streaming tests
// ---------------------------------------------------------------------------

function makeReaderMock(frames: string[]): {
  getReader: () => {
    read: () => Promise<{ done: boolean; value: Uint8Array | undefined }>;
    releaseLock: ReturnType<typeof vi.fn>;
  };
} {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    getReader: () => ({
      read: () => {
        if (i < frames.length) {
          return Promise.resolve({ done: false as const, value: encoder.encode(frames[i++]) });
        }
        return Promise.resolve({ done: true as const, value: undefined });
      },
      releaseLock: vi.fn(),
    }),
  };
}

describe('invokeA2ARuntimeStreaming SigV4', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('yields incremental chunks from status-update SSE events', async () => {
    const frames = [
      'data: {"kind":"status-update","status":{"state":"working","message":{"parts":[{"kind":"text","text":"Hello "}]}}}\n\n',
      'data: {"kind":"status-update","status":{"state":"working","message":{"parts":[{"kind":"text","text":"world"}]}}}\n\n',
    ];
    const stream = makeReaderMock(frames);
    mockSdkSend.mockResolvedValue({
      runtimeSessionId: 'sigv4-stream-session',
      response: { transformToWebStream: () => stream },
    });

    const result = await invokeA2ARuntimeStreaming(baseOpts, 'hello');
    const text = await drain(result.stream);

    expect(mockSdkSend).toHaveBeenCalledTimes(1);
    expect(text).toBe('Hello world');
    expect(result.sessionId).toBe('sigv4-stream-session');
  });

  it('yields artifact-update text with type:"text" parts (backward compat) when no status-update text', async () => {
    const frames = [
      'data: {"kind":"artifact-update","artifact":{"parts":[{"type":"text","text":"legacy output"}]}}\n\n',
    ];
    const stream = makeReaderMock(frames);
    mockSdkSend.mockResolvedValue({
      runtimeSessionId: 'sigv4-stream-session-2',
      response: { transformToWebStream: () => stream },
    });

    const result = await invokeA2ARuntimeStreaming(baseOpts, 'hello');
    const text = await drain(result.stream);

    expect(text).toBe('legacy output');
  });

  it('suppresses artifact-update when status-update already emitted text', async () => {
    const frames = [
      'data: {"kind":"status-update","status":{"state":"working","message":{"parts":[{"kind":"text","text":"status text"}]}}}\n\n',
      'data: {"kind":"artifact-update","artifact":{"parts":[{"kind":"text","text":"should be skipped"}]}}\n\n',
    ];
    const stream = makeReaderMock(frames);
    mockSdkSend.mockResolvedValue({
      runtimeSessionId: 'sigv4-stream-session-3',
      response: { transformToWebStream: () => stream },
    });

    const result = await invokeA2ARuntimeStreaming(baseOpts, 'hello');
    const text = await drain(result.stream);

    expect(text).toBe('status text');
  });

  it('yields trailing SSE data line without final newline', async () => {
    const frames = ['data: {"kind":"status-update","status":{"state":"working","message":{"parts":[{"kind":"text","text":"tail chunk"}]}}}'];
    const stream = makeReaderMock(frames);
    mockSdkSend.mockResolvedValue({
      runtimeSessionId: 'sigv4-stream-session-4',
      response: { transformToWebStream: () => stream },
    });

    const result = await invokeA2ARuntimeStreaming(baseOpts, 'hello');
    const text = await drain(result.stream);

    expect(text).toBe('tail chunk');
  });
});

describe('invokeA2ARuntimeStreaming bearer-token', () => {
  let fetchSpy: { mockRestore: () => void } | undefined;
  let capturedRequests: { url: string; init: RequestInit }[];

  afterEach(() => {
    fetchSpy?.mockRestore();
    vi.clearAllMocks();
  });

  function mockFetchStream(frames: string[], sessionId: string | null = 'bearer-stream-session'): void {
    capturedRequests = [];
    const stream = makeReaderMock(frames);
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      capturedRequests.push({ url: input as string, init: init! });
      return Promise.resolve({
        ok: true,
        status: 200,
        body: stream,
        headers: {
          get: (h: string) => (h === 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id' ? sessionId : null),
        },
      } as unknown as Response);
    });
  }

  it('uses message/stream method with Bearer token and yields SSE chunks', async () => {
    mockFetchStream([
      'data: {"kind":"status-update","status":{"state":"working","message":{"parts":[{"kind":"text","text":"streamed result"}]}}}\n\n',
    ]);

    const result = await invokeA2ARuntimeStreaming({ ...baseOpts, bearerToken: 'my-jwt' }, 'hello');
    const text = await drain(result.stream);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(mockSdkSend).not.toHaveBeenCalled();

    const headers = capturedRequests[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer my-jwt');

    const reqBody = JSON.parse(capturedRequests[0]!.init.body as string);
    expect(reqBody.method).toBe('message/stream');

    expect(text).toBe('streamed result');
    expect(result.sessionId).toBe('bearer-stream-session');
  });

  it('yields artifact-update text with type:"text" parts (backward compat)', async () => {
    mockFetchStream([
      'data: {"kind":"artifact-update","artifact":{"parts":[{"type":"text","text":"legacy bearer output"}]}}\n\n',
    ]);

    const result = await invokeA2ARuntimeStreaming({ ...baseOpts, bearerToken: 'my-jwt' }, 'hello');
    const text = await drain(result.stream);

    expect(text).toBe('legacy bearer output');
  });
});
