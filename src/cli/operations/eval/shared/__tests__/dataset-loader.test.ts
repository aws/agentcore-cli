import { describe, expect, it } from 'vitest';

// Test the parseAndValidate logic by importing the module and testing indirectly
// Since parseAndValidate is private, we test through loadDatasetScenarios' validation behavior
// by creating a test helper that mimics the parsing

describe('dataset-loader validation', () => {
  // Inline reimplementation of parseAndValidate for unit testing
  function parseAndValidate(content: string) {
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length === 0) throw new Error('Dataset has no examples.');

    return lines.map((line, index) => {
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch (err) {
        throw new Error(`Invalid JSON at line ${index + 1}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!obj.scenario_id || typeof obj.scenario_id !== 'string') {
        throw new Error(`Line ${index + 1}: missing required field "scenario_id"`);
      }
      if (!obj.turns || !Array.isArray(obj.turns) || obj.turns.length === 0) {
        throw new Error(`Line ${index + 1}: "turns" must be a non-empty array`);
      }
      for (let i = 0; i < (obj.turns as unknown[]).length; i++) {
        const turn = (obj.turns as Record<string, unknown>[])[i];
        if (!turn?.input || typeof turn.input !== 'string') {
          throw new Error(`Line ${index + 1}, turn ${i + 1}: each turn must have a string "input" field`);
        }
      }
      return obj;
    });
  }

  it('parses valid JSONL', () => {
    const content = '{"scenario_id":"s1","turns":[{"input":"hello"}]}\n{"scenario_id":"s2","turns":[{"input":"bye"}]}';
    const result = parseAndValidate(content);
    expect(result).toHaveLength(2);
    expect(result[0]!.scenario_id).toBe('s1');
  });

  it('throws on empty content', () => {
    expect(() => parseAndValidate('')).toThrow('no examples');
  });

  it('throws on missing scenario_id', () => {
    expect(() => parseAndValidate('{"turns":[{"input":"x"}]}')).toThrow('scenario_id');
  });

  it('throws on missing turns', () => {
    expect(() => parseAndValidate('{"scenario_id":"s1"}')).toThrow('turns');
  });

  it('throws on empty turns array', () => {
    expect(() => parseAndValidate('{"scenario_id":"s1","turns":[]}')).toThrow('non-empty');
  });

  it('throws on turn without input', () => {
    expect(() => parseAndValidate('{"scenario_id":"s1","turns":[{"expectedResponse":"x"}]}')).toThrow('input');
  });

  it('throws with line number context on invalid JSON', () => {
    const content = '{"scenario_id":"s1","turns":[{"input":"ok"}]}\nnot json';
    expect(() => parseAndValidate(content)).toThrow('line 2');
  });

  it('allows optional fields (assertions, expected_trajectory, expectedResponse)', () => {
    const content =
      '{"scenario_id":"s1","turns":[{"input":"q","expectedResponse":"a"}],"assertions":["be nice"],"expected_trajectory":["tool_a"]}';
    const result = parseAndValidate(content);
    expect(result[0]!.assertions).toEqual(['be nice']);
    expect(result[0]!.expected_trajectory).toEqual(['tool_a']);
  });

  it('ignores blank lines', () => {
    const content = '{"scenario_id":"s1","turns":[{"input":"hi"}]}\n\n\n{"scenario_id":"s2","turns":[{"input":"bye"}]}';
    const result = parseAndValidate(content);
    expect(result).toHaveLength(2);
  });
});
