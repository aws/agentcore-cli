import { fetchSessionSpans } from '../fetch-session-spans';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSearchLogs = vi.fn();

vi.mock('../../../aws/cloudwatch', () => ({
  searchLogs: (...args: unknown[]) => mockSearchLogs(...args),
}));

/**
 * Helper: create an async generator from an array of log events.
 */
async function* fakeLogStream(events: { timestamp: number; message: string }[]) {
  for (const e of events) {
    yield await Promise.resolve(e);
  }
}

/** Helper: create an async generator that throws on first iteration. */
// eslint-disable-next-line require-yield
async function* fakeErrorStream(error: Error): AsyncGenerator<{ timestamp: number; message: string }> {
  await Promise.resolve();
  throw error;
}

const SESSION_ID = 'sess-abc-123';

function makeSpanRecord(traceId: string, spanId: string) {
  return {
    timestamp: Date.now(),
    message: JSON.stringify({
      traceId,
      spanId,
      scope: { name: 'strands.telemetry.tracer' },
      attributes: { 'session.id': SESSION_ID },
      body: {},
    }),
  };
}

function makeLogRecord(traceId: string, spanId: string, sessionId: string) {
  return {
    timestamp: Date.now(),
    message: JSON.stringify({
      traceId,
      spanId,
      attributes: { 'session.id': sessionId },
      body: {
        input: { messages: [{ content: { content: 'hello' }, role: 'user' }] },
        output: { messages: [{ content: { content: 'hi' }, role: 'assistant' }] },
      },
    }),
  };
}

describe('fetchSessionSpans', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('combines span records and log records for the same session', async () => {
    const spanEvents = [makeSpanRecord('trace1', 'span1'), makeSpanRecord('trace1', 'span2')];
    const logEvents = [makeLogRecord('trace1', 'span3', SESSION_ID)];

    // First call = aws/spans, second call = runtime log group
    mockSearchLogs.mockReturnValueOnce(fakeLogStream(spanEvents)).mockReturnValueOnce(fakeLogStream(logEvents));

    const result = await fetchSessionSpans({
      region: 'us-east-1',
      runtimeId: 'myproject_MyAgent-QMd093Gl4O',
      sessionId: SESSION_ID,
    });

    expect(result.spans).toHaveLength(3);
    expect(result.spanRecordCount).toBe(2);
    expect(result.logRecordCount).toBe(1);
  });

  it('filters out log records from other sessions', async () => {
    const spanEvents = [makeSpanRecord('trace1', 'span1')];
    const logEvents = [
      makeLogRecord('trace1', 'span2', SESSION_ID),
      makeLogRecord('trace1', 'span3', 'other-session-id'),
    ];

    mockSearchLogs.mockReturnValueOnce(fakeLogStream(spanEvents)).mockReturnValueOnce(fakeLogStream(logEvents));

    const result = await fetchSessionSpans({
      region: 'us-east-1',
      runtimeId: 'myproject_MyAgent-QMd093Gl4O',
      sessionId: SESSION_ID,
    });

    expect(result.spans).toHaveLength(2);
    expect(result.logRecordCount).toBe(1);
  });

  it('returns empty spans when no records found', async () => {
    mockSearchLogs.mockReturnValueOnce(fakeLogStream([])).mockReturnValueOnce(fakeLogStream([]));

    const result = await fetchSessionSpans({
      region: 'us-east-1',
      runtimeId: 'myproject_MyAgent-QMd093Gl4O',
      sessionId: SESSION_ID,
    });

    expect(result.spans).toHaveLength(0);
    expect(result.spanRecordCount).toBe(0);
    expect(result.logRecordCount).toBe(0);
  });

  it('handles ResourceNotFoundException gracefully (log group does not exist)', async () => {
    // Spans log group works, runtime log group does not exist
    mockSearchLogs
      .mockReturnValueOnce(fakeLogStream([makeSpanRecord('t1', 's1')]))
      .mockReturnValueOnce(
        fakeErrorStream(new Error('ResourceNotFoundException: The specified log group does not exist'))
      );

    const result = await fetchSessionSpans({
      region: 'us-east-1',
      runtimeId: 'myproject_MyAgent-QMd093Gl4O',
      sessionId: SESSION_ID,
    });

    // Should still return span records from aws/spans
    expect(result.spans).toHaveLength(1);
    expect(result.spanRecordCount).toBe(1);
    expect(result.logRecordCount).toBe(0);
  });

  it('rethrows non-ResourceNotFoundException errors', async () => {
    mockSearchLogs
      .mockReturnValueOnce(fakeLogStream([]))
      .mockReturnValueOnce(fakeErrorStream(new Error('AccessDeniedException: Not authorized')));

    await expect(
      fetchSessionSpans({
        region: 'us-east-1',
        runtimeId: 'myproject_MyAgent-QMd093Gl4O',
        sessionId: SESSION_ID,
      })
    ).rejects.toThrow('AccessDeniedException');
  });

  it('skips unparseable log messages', async () => {
    const spanEvents = [{ timestamp: Date.now(), message: 'not-valid-json' }, makeSpanRecord('trace1', 'span1')];

    mockSearchLogs.mockReturnValueOnce(fakeLogStream(spanEvents)).mockReturnValueOnce(fakeLogStream([]));

    const result = await fetchSessionSpans({
      region: 'us-east-1',
      runtimeId: 'myproject_MyAgent-QMd093Gl4O',
      sessionId: SESSION_ID,
    });

    expect(result.spans).toHaveLength(1);
  });

  it('uses correct log group names', async () => {
    mockSearchLogs.mockReturnValueOnce(fakeLogStream([])).mockReturnValueOnce(fakeLogStream([]));

    await fetchSessionSpans({
      region: 'us-east-1',
      runtimeId: 'myproject_MyAgent-QMd093Gl4O',
      sessionId: SESSION_ID,
      lookbackDays: 3,
    });

    expect(mockSearchLogs).toHaveBeenCalledTimes(2);

    // First call: aws/spans
    const spanCall = mockSearchLogs.mock.calls[0]![0];
    expect(spanCall.logGroupName).toBe('aws/spans');
    expect(spanCall.filterPattern).toContain(SESSION_ID);

    // Second call: runtime log group
    const logCall = mockSearchLogs.mock.calls[1]![0];
    expect(logCall.logGroupName).toBe('/aws/bedrock-agentcore/runtimes/myproject_MyAgent-QMd093Gl4O-DEFAULT');
    expect(logCall.filterPattern).toContain('"body" "input"');
  });

  it('calls onProgress callback', async () => {
    mockSearchLogs
      .mockReturnValueOnce(fakeLogStream([makeSpanRecord('t1', 's1')]))
      .mockReturnValueOnce(fakeLogStream([]));

    const progress: string[] = [];
    await fetchSessionSpans({
      region: 'us-east-1',
      runtimeId: 'rt-123',
      sessionId: SESSION_ID,
      onProgress: msg => progress.push(msg),
    });

    expect(progress.length).toBeGreaterThan(0);
    expect(progress.some(m => m.includes('span records'))).toBe(true);
  });

  it('matches log records by session ID in body (fallback)', async () => {
    // Log record with session ID only in body, not in attributes
    const logEvent = {
      timestamp: Date.now(),
      message: JSON.stringify({
        traceId: 'trace1',
        spanId: 'span1',
        attributes: {},
        body: {
          input: { messages: [{ content: { content: `session ${SESSION_ID} data` }, role: 'user' }] },
        },
      }),
    };

    mockSearchLogs.mockReturnValueOnce(fakeLogStream([])).mockReturnValueOnce(fakeLogStream([logEvent]));

    const result = await fetchSessionSpans({
      region: 'us-east-1',
      runtimeId: 'rt-123',
      sessionId: SESSION_ID,
    });

    expect(result.logRecordCount).toBe(1);
  });
});
