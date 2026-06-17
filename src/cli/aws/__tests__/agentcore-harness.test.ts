import { deleteHarness, getHarness, invokeHarness } from '../agentcore-harness.js';
import { EventStreamCodec } from '@smithy/eventstream-codec';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRequest, mockRequestRaw } = vi.hoisted(() => ({
  mockRequest: vi.fn(),
  mockRequestRaw: vi.fn(),
}));

vi.mock('../api-client', () => ({
  AgentCoreApiClient: class {
    request = mockRequest;
    requestRaw = mockRequestRaw;
  },
  AgentCoreApiError: class extends Error {
    statusCode: number;
    requestId: string | undefined;
    errorBody: string;
    constructor(statusCode: number, errorBody: string, requestId?: string) {
      super(`AgentCore API error (${statusCode}): ${errorBody}`);
      this.statusCode = statusCode;
      this.requestId = requestId;
      this.errorBody = errorBody;
    }
  },
}));

describe('Harness control plane operations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getHarness', () => {
    it('sends GET /harnesses/{harnessId}', async () => {
      const harness = { harnessId: 'h-123', status: 'READY' };
      mockRequest.mockResolvedValue({ harness });

      const result = await getHarness({ region: 'us-west-2', harnessId: 'h-123' });

      expect(result.harness.status).toBe('READY');
      expect(mockRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'GET',
          path: '/harnesses/h-123',
        })
      );
    });
  });

  describe('deleteHarness', () => {
    it('sends DELETE /harnesses/{harnessId} with clientToken query param', async () => {
      mockRequest.mockResolvedValue({ harness: { harnessId: 'h-123', status: 'DELETING' } });

      await deleteHarness({ region: 'us-west-2', harnessId: 'h-123' });

      expect(mockRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'DELETE',
          path: '/harnesses/h-123',
          query: { clientToken: expect.any(String) },
        })
      );
    });
  });
});

describe('invokeHarness (streaming)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const toUtf8 = (input: Uint8Array) => new TextDecoder().decode(input);
  const fromUtf8 = (input: string) => new TextEncoder().encode(input);
  const codec = new EventStreamCodec(toUtf8, fromUtf8);

  function encodeEvent(eventType: string, payload: Record<string, unknown>): Uint8Array {
    return codec.encode({
      headers: {
        ':event-type': { type: 'string', value: eventType },
        ':content-type': { type: 'string', value: 'application/json' },
        ':message-type': { type: 'string', value: 'event' },
      },
      body: fromUtf8(JSON.stringify(payload)),
    });
  }

  function makeStreamResponse(frames: Uint8Array[]): Response {
    let totalLen = 0;
    for (const f of frames) totalLen += f.length;
    const combined = new Uint8Array(totalLen);
    let off = 0;
    for (const f of frames) {
      combined.set(f, off);
      off += f.length;
    }
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(combined);
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  }

  it('yields messageStart events', async () => {
    mockRequestRaw.mockResolvedValue(makeStreamResponse([encodeEvent('messageStart', { role: 'assistant' })]));

    const events = [];
    for await (const event of invokeHarness({
      region: 'us-west-2',
      harnessArn: 'arn:aws:bedrock-agentcore:us-west-2:123:harness/h-123',
      runtimeSessionId: 'sess-1',
      messages: [{ role: 'user', content: [{ text: 'hello' }] }],
    })) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'messageStart', role: 'assistant' });
  });

  it('yields text deltas', async () => {
    mockRequestRaw.mockResolvedValue(
      makeStreamResponse([
        encodeEvent('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'Hello' } }),
        encodeEvent('contentBlockDelta', { contentBlockIndex: 0, delta: { text: ' world' } }),
      ])
    );

    const events = [];
    for await (const event of invokeHarness({
      region: 'us-west-2',
      harnessArn: 'arn:harness',
      runtimeSessionId: 'sess-1',
      messages: [{ role: 'user', content: [{ text: 'hi' }] }],
    })) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      type: 'contentBlockDelta',
      contentBlockIndex: 0,
      delta: { type: 'text', text: 'Hello' },
    });
    expect(events[1]).toEqual({
      type: 'contentBlockDelta',
      contentBlockIndex: 0,
      delta: { type: 'text', text: ' world' },
    });
  });

  it('yields tool use start events', async () => {
    mockRequestRaw.mockResolvedValue(
      makeStreamResponse([
        encodeEvent('contentBlockStart', {
          contentBlockIndex: 1,
          start: { toolUse: { toolUseId: 'tu-1', name: 'exa_search', type: 'remote_mcp', serverName: 'exa' } },
        }),
      ])
    );

    const events = [];
    for await (const event of invokeHarness({
      region: 'us-west-2',
      harnessArn: 'arn:harness',
      runtimeSessionId: 'sess-1',
      messages: [{ role: 'user', content: [{ text: 'search' }] }],
    })) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'contentBlockStart',
      contentBlockIndex: 1,
      start: {
        type: 'toolUse',
        toolUse: { toolUseId: 'tu-1', name: 'exa_search', type: 'remote_mcp', serverName: 'exa' },
      },
    });
  });

  it('yields messageStop with stopReason', async () => {
    mockRequestRaw.mockResolvedValue(makeStreamResponse([encodeEvent('messageStop', { stopReason: 'end_turn' })]));

    const events = [];
    for await (const event of invokeHarness({
      region: 'us-west-2',
      harnessArn: 'arn:harness',
      runtimeSessionId: 'sess-1',
      messages: [{ role: 'user', content: [{ text: 'hi' }] }],
    })) {
      events.push(event);
    }

    expect(events[0]).toEqual({ type: 'messageStop', stopReason: 'end_turn' });
  });

  it('yields metadata with token usage', async () => {
    mockRequestRaw.mockResolvedValue(
      makeStreamResponse([
        encodeEvent('metadata', {
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
          metrics: { latencyMs: 1200 },
        }),
      ])
    );

    const events = [];
    for await (const event of invokeHarness({
      region: 'us-west-2',
      harnessArn: 'arn:harness',
      runtimeSessionId: 'sess-1',
      messages: [{ role: 'user', content: [{ text: 'hi' }] }],
    })) {
      events.push(event);
    }

    expect(events[0]).toEqual({
      type: 'metadata',
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      metrics: { latencyMs: 1200 },
    });
  });

  it('yields error events for exception event types', async () => {
    mockRequestRaw.mockResolvedValue(
      makeStreamResponse([encodeEvent('internalServerException', { message: 'Something broke' })])
    );

    const events = [];
    for await (const event of invokeHarness({
      region: 'us-west-2',
      harnessArn: 'arn:harness',
      runtimeSessionId: 'sess-1',
      messages: [{ role: 'user', content: [{ text: 'hi' }] }],
    })) {
      events.push(event);
    }

    expect(events[0]).toEqual({
      type: 'error',
      errorType: 'internalServerException',
      message: 'Something broke',
    });
  });

  it('passes override options in request body', async () => {
    mockRequestRaw.mockResolvedValue(makeStreamResponse([]));

    for await (const _event of invokeHarness({
      region: 'us-west-2',
      harnessArn: 'arn:harness',
      runtimeSessionId: 'sess-1',
      messages: [{ role: 'user', content: [{ text: 'hi' }] }],
      model: { bedrockModelConfig: { modelId: 'override-model' } },
      maxIterations: 20,
      skills: [{ path: './skills/research' }],
    })) {
      // drain
    }

    expect(mockRequestRaw).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        path: '/harnesses/invoke',
        query: { harnessArn: 'arn:harness' },
        headers: { 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': 'sess-1' },
        body: expect.objectContaining({
          model: { bedrockModelConfig: { modelId: 'override-model' } },
          maxIterations: 20,
          skills: [{ path: './skills/research' }],
        }),
      })
    );
  });

  it('handles multiple event types in sequence', async () => {
    mockRequestRaw.mockResolvedValue(
      makeStreamResponse([
        encodeEvent('messageStart', { role: 'assistant' }),
        encodeEvent('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'Hi' } }),
        encodeEvent('contentBlockStop', { contentBlockIndex: 0 }),
        encodeEvent('messageStop', { stopReason: 'end_turn' }),
        encodeEvent('metadata', {
          usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
          metrics: { latencyMs: 100 },
        }),
      ])
    );

    const events = [];
    for await (const event of invokeHarness({
      region: 'us-west-2',
      harnessArn: 'arn:harness',
      runtimeSessionId: 'sess-1',
      messages: [{ role: 'user', content: [{ text: 'hi' }] }],
    })) {
      events.push(event);
    }

    expect(events).toHaveLength(5);
    expect(events.map(e => e.type)).toEqual([
      'messageStart',
      'contentBlockDelta',
      'contentBlockStop',
      'messageStop',
      'metadata',
    ]);
  });
});
