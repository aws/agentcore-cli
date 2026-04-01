import { mcpListTools } from '../agentcore.js';
import type { McpInvokeOptions } from '../agentcore.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the SDK so SigV4 path doesn't need real credentials
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

// Mock credential provider
vi.mock('../account.js', () => ({
  getCredentialProvider: vi.fn().mockReturnValue(() =>
    Promise.resolve({
      accessKeyId: 'test',
      secretAccessKey: 'test',
    })
  ),
}));

function makeJsonRpcResponse(result: Record<string, unknown>, sessionId?: string) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result });
  const headers = new Map<string, string>();
  if (sessionId) {
    headers.set('Mcp-Session-Id', sessionId);
  }
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(body),
    headers: {
      get: (name: string) => headers.get(name) ?? null,
    },
  };
}

function makeErrorResponse(status: number, body: string) {
  return {
    ok: false,
    status,
    statusText: 'Unauthorized',
    text: () => Promise.resolve(body),
    headers: {
      get: () => null,
    },
  };
}

const baseBearerOpts: McpInvokeOptions = {
  region: 'us-east-1',
  runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789:runtime/test-runtime',
  bearerToken: 'test-jwt-token',
  userId: 'test-user',
};

const baseSigV4Opts: McpInvokeOptions = {
  region: 'us-east-1',
  runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789:runtime/test-runtime',
  userId: 'test-user',
};

describe('MCP bearer-token auth path', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let capturedRequests: { url: string; init: RequestInit }[];

  beforeEach(() => {
    capturedRequests = [];
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      capturedRequests.push({ url: input as string, init: init! });

      // Return appropriate response based on the JSON-RPC method
      const body = JSON.parse(init?.body as string);
      if (body.method === 'initialize') {
        return Promise.resolve(
          makeJsonRpcResponse({ protocolVersion: '2025-03-26', capabilities: {} }, 'mcp-session-123') as Response
        );
      }
      if (body.method === 'notifications/initialized') {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(''),
          headers: { get: () => null },
        } as unknown as Response);
      }
      if (body.method === 'tools/list') {
        return Promise.resolve(
          makeJsonRpcResponse(
            {
              tools: [{ name: 'search_flights', description: 'Search flights' }],
            },
            'mcp-session-123'
          ) as Response
        );
      }
      return Promise.resolve(makeJsonRpcResponse({}) as Response);
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('mcpListTools with bearerToken uses fetch with correct Authorization header', async () => {
    await mcpListTools(baseBearerOpts);

    expect(fetchSpy).toHaveBeenCalled();
    expect(capturedRequests.length).toBeGreaterThanOrEqual(2);

    const initHeaders = capturedRequests[0]!.init.headers as Record<string, string>;
    expect(initHeaders.Authorization).toBe('Bearer test-jwt-token');
  });

  it('mcpListTools with bearerToken sets Mcp-Protocol-Version and Mcp-Session-Id headers', async () => {
    await mcpListTools(baseBearerOpts);

    // First request (initialize) should have Mcp-Protocol-Version but not Mcp-Session-Id (no session yet)
    const initHeaders = capturedRequests[0]!.init.headers as Record<string, string>;
    expect(initHeaders['Mcp-Protocol-Version']).toBe('2025-03-26');
    expect(initHeaders['Mcp-Session-Id']).toBeUndefined();

    // Subsequent requests (notification, tools/list) should have Mcp-Session-Id from initialize response
    const notifyHeaders = capturedRequests[1]!.init.headers as Record<string, string>;
    expect(notifyHeaders['Mcp-Session-Id']).toBe('mcp-session-123');
    expect(notifyHeaders['Mcp-Protocol-Version']).toBe('2025-03-26');
  });

  it('mcpListTools with bearerToken sets X-Amzn-Bedrock-AgentCore-Runtime-User-Id header', async () => {
    await mcpListTools(baseBearerOpts);

    const initHeaders = capturedRequests[0]!.init.headers as Record<string, string>;
    expect(initHeaders['X-Amzn-Bedrock-AgentCore-Runtime-User-Id']).toBe('test-user');
  });

  it('mcpListTools with bearerToken extracts mcpSessionId from Mcp-Session-Id response header', async () => {
    const result = await mcpListTools(baseBearerOpts);

    expect(result.mcpSessionId).toBe('mcp-session-123');
  });

  it('mcpListTools with bearerToken surfaces HTTP errors', async () => {
    fetchSpy.mockRestore();
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      return Promise.resolve(makeErrorResponse(401, 'Token expired') as unknown as Response);
    });

    await expect(mcpListTools(baseBearerOpts)).rejects.toThrow(/MCP call failed \(401\)/);
  });

  it('mcpListTools with bearerToken returns parsed tools', async () => {
    const result = await mcpListTools(baseBearerOpts);

    expect(result.tools).toEqual([{ name: 'search_flights', description: 'Search flights' }]);
  });

  it('mcpListTools without bearerToken uses SDK client (not fetch)', async () => {
    // Set up SDK mock to return valid responses
    mockSdkSend.mockImplementation(() =>
      Promise.resolve({
        response: {
          transformToByteArray: () =>
            Promise.resolve(
              new TextEncoder().encode(
                JSON.stringify({
                  jsonrpc: '2.0',
                  id: 1,
                  result: { protocolVersion: '2025-03-26', capabilities: {}, tools: [{ name: 'test_tool' }] },
                })
              )
            ),
        },
        mcpSessionId: 'sdk-session-456',
      })
    );

    await mcpListTools(baseSigV4Opts);

    // SDK send should have been called, fetch should NOT have been called for MCP requests
    expect(mockSdkSend).toHaveBeenCalled();
    // fetch may have been called 0 times (all through SDK)
    const mcpFetchCalls = capturedRequests.filter(r => r.url.includes('bedrock-agentcore'));
    expect(mcpFetchCalls).toHaveLength(0);
  });

  it('mcpListTools with bearerToken forwards custom headers', async () => {
    const opts: McpInvokeOptions = {
      ...baseBearerOpts,
      headers: { 'X-Custom-Header': 'custom-value' },
    };

    await mcpListTools(opts);

    const initHeaders = capturedRequests[0]!.init.headers as Record<string, string>;
    expect(initHeaders['X-Custom-Header']).toBe('custom-value');
  });
});
