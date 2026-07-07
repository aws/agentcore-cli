import { buildReferenceInputs } from '../dataset-session-provider';
import { describe, expect, it } from 'vitest';

describe('buildReferenceInputs', () => {
  it('builds session-level assertions and trajectory', () => {
    const result = buildReferenceInputs({
      scenario: {
        scenario_id: 'test',
        turns: [{ input: 'hello' }],
        assertions: ['Agent should greet'],
        expected_trajectory: ['greet_user'],
      },
      sessionId: 'sess-1',
      traceIds: ['trace-1'],
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.context.spanContext.sessionId).toBe('sess-1');
    expect(result[0]!.assertions).toEqual([{ text: 'Agent should greet' }]);
    expect(result[0]!.expectedTrajectory).toEqual({ toolNames: ['greet_user'] });
  });

  it('maps per-turn expectedResponse to traceIds by index', () => {
    const result = buildReferenceInputs({
      scenario: {
        scenario_id: 'test',
        turns: [
          { input: 'q1', expectedResponse: 'a1' },
          { input: 'q2', expectedResponse: 'a2' },
        ],
      },
      sessionId: 'sess-1',
      traceIds: ['trace-1', 'trace-2'],
    });

    expect(result).toHaveLength(2);
    expect(result[0]!.context.spanContext.traceId).toBe('trace-1');
    expect(result[0]!.expectedResponse).toEqual({ text: 'a1' });
    expect(result[1]!.context.spanContext.traceId).toBe('trace-2');
    expect(result[1]!.expectedResponse).toEqual({ text: 'a2' });
  });

  it('skips extra turns when fewer traceIds than turns (SDK behavior)', () => {
    const result = buildReferenceInputs({
      scenario: {
        scenario_id: 'test',
        turns: [
          { input: 'q1', expectedResponse: 'a1' },
          { input: 'q2', expectedResponse: 'a2' },
          { input: 'q3', expectedResponse: 'a3' },
        ],
      },
      sessionId: 'sess-1',
      traceIds: ['trace-1'], // only 1 trace for 3 turns
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.expectedResponse).toEqual({ text: 'a1' });
  });

  it('skips turns without expectedResponse', () => {
    const result = buildReferenceInputs({
      scenario: {
        scenario_id: 'test',
        turns: [{ input: 'q1' }, { input: 'q2', expectedResponse: 'a2' }],
      },
      sessionId: 'sess-1',
      traceIds: ['trace-1', 'trace-2'],
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.context.spanContext.traceId).toBe('trace-2');
    expect(result[0]!.expectedResponse).toEqual({ text: 'a2' });
  });

  it('returns empty when no ground truth provided', () => {
    const result = buildReferenceInputs({
      scenario: {
        scenario_id: 'test',
        turns: [{ input: 'hello' }],
      },
      sessionId: 'sess-1',
      traceIds: ['trace-1'],
    });

    expect(result).toHaveLength(0);
  });

  it('combines session-level and per-trace inputs', () => {
    const result = buildReferenceInputs({
      scenario: {
        scenario_id: 'test',
        turns: [{ input: 'q1', expectedResponse: 'a1' }],
        assertions: ['Be helpful'],
        expected_trajectory: ['tool_a'],
      },
      sessionId: 'sess-1',
      traceIds: ['trace-1'],
    });

    expect(result).toHaveLength(2);
    // Session-level
    expect(result[0]!.assertions).toEqual([{ text: 'Be helpful' }]);
    expect(result[0]!.context.spanContext.traceId).toBeUndefined();
    // Per-trace
    expect(result[1]!.expectedResponse).toEqual({ text: 'a1' });
    expect(result[1]!.context.spanContext.traceId).toBe('trace-1');
  });
});
