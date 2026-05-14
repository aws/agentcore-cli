import { invokeHarness } from '../../../../aws/agentcore-harness.js';
import type { HarnessStreamEvent } from '../../../../aws/agentcore-harness.js';
import { handleHarnessToolResponse } from '../handlers/harness-tool-response.js';
import type { RouteContext } from '../handlers/route-context.js';
import type { IncomingMessage, ServerResponse } from 'http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../aws/agentcore-harness.js', () => ({
  invokeHarness: vi.fn(),
}));

function mockReq(): IncomingMessage {
  return {} as IncomingMessage;
}

function mockRes(): ServerResponse & {
  _status: number;
  _headers: Record<string, string>;
  _chunks: string[];
  _ended: boolean;
} {
  const res = {
    _status: 0,
    _headers: {} as Record<string, string>,
    _chunks: [] as string[],
    _ended: false,
    headersSent: false,
    writeHead(status: number, headers?: Record<string, string>) {
      res._status = status;
      res.headersSent = true;
      if (headers) Object.assign(res._headers, headers);
      return res;
    },
    setHeader(name: string, value: string) {
      res._headers[name] = value;
    },
    write(chunk: string) {
      res._chunks.push(chunk);
      return true;
    },
    end(body?: string) {
      if (body) res._chunks.push(body);
      res._ended = true;
    },
  };
  return res as unknown as ServerResponse & {
    _status: number;
    _headers: Record<string, string>;
    _chunks: string[];
    _ended: boolean;
  };
}

function mockCtx(overrides: Partial<RouteContext> = {}): RouteContext {
  return {
    options: {
      mode: 'dev',
      agents: [],
      harnesses: [
        {
          name: 'test-harness',
          harnessArn: 'arn:aws:bedrock-agentcore:us-west-2:123:harness/abc',
          region: 'us-west-2',
        },
      ],
      uiPort: 8081,
    },
    runningAgents: new Map(),
    startingAgents: new Map(),
    agentErrors: new Map(),
    setCorsHeaders: vi.fn(),
    readBody: vi.fn(),
    ...overrides,
  };
}

async function* fakeStream(events: HarnessStreamEvent[]): AsyncGenerator<HarnessStreamEvent> {
  for (const event of events) {
    yield await Promise.resolve(event);
  }
}

describe('handleHarnessToolResponse', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 400 when harnessName is missing', async () => {
    const ctx = mockCtx({
      readBody: vi.fn().mockResolvedValue(JSON.stringify({ sessionId: 's1', messages: [] })),
    });
    const res = mockRes();

    await handleHarnessToolResponse(ctx, mockReq(), res, undefined);

    expect(res._status).toBe(400);
    expect(res._chunks[0]).toBeDefined();
    expect(JSON.parse(res._chunks[0]!)).toEqual({ success: false, error: 'harnessName is required' });
  });

  it('returns 400 when messages is missing', async () => {
    const ctx = mockCtx({
      readBody: vi.fn().mockResolvedValue(JSON.stringify({ harnessName: 'test-harness', sessionId: 's1' })),
    });
    const res = mockRes();

    await handleHarnessToolResponse(ctx, mockReq(), res, undefined);

    expect(res._status).toBe(400);
    expect(res._chunks[0]).toBeDefined();
    expect(JSON.parse(res._chunks[0]!)).toEqual({ success: false, error: 'messages array is required' });
  });

  it('returns 404 when harness not found', async () => {
    const ctx = mockCtx({
      readBody: vi.fn().mockResolvedValue(JSON.stringify({ harnessName: 'unknown', sessionId: 's1', messages: [] })),
    });
    const res = mockRes();

    await handleHarnessToolResponse(ctx, mockReq(), res, undefined);

    expect(res._status).toBe(404);
    expect(res._chunks[0]).toBeDefined();
    expect(JSON.parse(res._chunks[0]!)).toEqual({ success: false, error: 'Harness "unknown" not found' });
  });

  it('passes messages to invokeHarness and streams SSE response', async () => {
    const toolMessages = [
      { role: 'assistant', content: [{ toolUse: { toolUseId: 't1', name: 'search', input: { q: 'test' } } }] },
      {
        role: 'user',
        content: [{ toolResult: { toolUseId: 't1', content: [{ text: 'result' }], status: 'success' } }],
      },
    ];
    vi.mocked(invokeHarness).mockReturnValue(
      fakeStream([
        { type: 'messageStart', role: 'assistant' },
        { type: 'contentBlockDelta', contentBlockIndex: 0, delta: { type: 'text', text: 'Done' } },
        { type: 'messageStop', stopReason: 'end_turn' },
      ])
    );

    const ctx = mockCtx({
      readBody: vi.fn().mockResolvedValue(
        JSON.stringify({
          harnessName: 'test-harness',
          sessionId: 'sess-1',
          messages: toolMessages,
        })
      ),
    });
    const res = mockRes();

    await handleHarnessToolResponse(ctx, mockReq(), res, undefined);

    expect(invokeHarness).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: toolMessages,
        runtimeSessionId: 'sess-1',
        harnessArn: 'arn:aws:bedrock-agentcore:us-west-2:123:harness/abc',
      })
    );

    expect(res._status).toBe(200);
    const sseLines = res._chunks.filter(c => c.startsWith('data: '));
    expect(sseLines).toHaveLength(3);
  });
});
