import { buildReferenceInputs } from '../dataset-session-provider.js';
import { describe, expect, it } from 'vitest';

describe('buildReferenceInputs', () => {
  it('includes session-level assertions when scenario has assertions', () => {
    const result = buildReferenceInputs({
      scenario: {
        scenario_id: 'test',
        turns: [{ input: 'hello' }],
        assertions: ['Agent greets politely', 'Agent responds in English'],
      },
      sessionId: 'sess-1',
      traceIds: ['trace-1'],
    });

    expect(result.length).toBeGreaterThanOrEqual(1);
    const sessionLevel = result.find(r => !r.context.spanContext.traceId);
    expect(sessionLevel).toBeDefined();
    expect(sessionLevel!.assertions).toEqual([
      { text: 'Agent greets politely' },
      { text: 'Agent responds in English' },
    ]);
  });

  it('includes session-level expected_trajectory when present', () => {
    const result = buildReferenceInputs({
      scenario: {
        scenario_id: 'test',
        turns: [{ input: 'hello' }],
        expected_trajectory: ['lookup_user', 'greet'],
      },
      sessionId: 'sess-1',
      traceIds: ['trace-1'],
    });

    const sessionLevel = result.find(r => !r.context.spanContext.traceId);
    expect(sessionLevel).toBeDefined();
    expect(sessionLevel!.expectedTrajectory).toEqual({ toolNames: ['lookup_user', 'greet'] });
  });

  it('maps turn.expectedResponse to traceId by index', () => {
    const result = buildReferenceInputs({
      scenario: {
        scenario_id: 'test',
        turns: [
          { input: 'q1', expectedResponse: 'answer1' },
          { input: 'q2', expectedResponse: 'answer2' },
        ],
      },
      sessionId: 'sess-1',
      traceIds: ['trace-a', 'trace-b'],
    });

    expect(result).toHaveLength(2);
    expect(result[0]!.context.spanContext.traceId).toBe('trace-a');
    expect(result[0]!.expectedResponse).toEqual({ text: 'answer1' });
    expect(result[1]!.context.spanContext.traceId).toBe('trace-b');
    expect(result[1]!.expectedResponse).toEqual({ text: 'answer2' });
  });

  it('stops mapping when traceIds exhausted', () => {
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
      traceIds: ['trace-1'], // only 1 traceId for 3 turns
    });

    // Only 1 result because we ran out of traceIds
    expect(result).toHaveLength(1);
    expect(result[0]!.expectedResponse).toEqual({ text: 'a1' });
  });

  it('returns empty array when scenario has no ground truth', () => {
    const result = buildReferenceInputs({
      scenario: {
        scenario_id: 'test',
        turns: [{ input: 'hello' }, { input: 'goodbye' }],
      },
      sessionId: 'sess-1',
      traceIds: ['trace-1', 'trace-2'],
    });

    expect(result).toHaveLength(0);
  });
});
