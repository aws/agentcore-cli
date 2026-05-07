import { formatFilter, parseFiltersInput } from '../filter-parser';
import { describe, expect, it } from 'vitest';

describe('parseFiltersInput', () => {
  describe('value typing', () => {
    it('treats bare true/false as booleans', () => {
      const result = parseFiltersInput('success Equals true; failed Equals false');
      expect(result).toEqual([
        { key: 'success', operator: 'Equals', value: { booleanValue: true } },
        { key: 'failed', operator: 'Equals', value: { booleanValue: false } },
      ]);
    });

    it('treats bare integer values as doubles', () => {
      const result = parseFiltersInput('latencyMs LessThan 1000');
      expect(result).toEqual([
        { key: 'latencyMs', operator: 'LessThan', value: { doubleValue: 1000 } },
      ]);
    });

    it('treats bare decimal values as doubles', () => {
      const result = parseFiltersInput('score GreaterThan -0.5');
      expect(result).toEqual([
        { key: 'score', operator: 'GreaterThan', value: { doubleValue: -0.5 } },
      ]);
    });

    it('treats bare non-numeric, non-boolean values as strings', () => {
      const result = parseFiltersInput('model Equals claude-3');
      expect(result).toEqual([
        { key: 'model', operator: 'Equals', value: { stringValue: 'claude-3' } },
      ]);
    });

    it('treats double-quoted values as strings even when they look numeric', () => {
      const result = parseFiltersInput('id Equals "12345"');
      expect(result).toEqual([{ key: 'id', operator: 'Equals', value: { stringValue: '12345' } }]);
    });

    it('treats double-quoted "true"/"false" as strings, not booleans', () => {
      const result = parseFiltersInput('flag Equals "true"');
      expect(result).toEqual([{ key: 'flag', operator: 'Equals', value: { stringValue: 'true' } }]);
    });

    it('treats quoted empty string as an empty stringValue', () => {
      const result = parseFiltersInput('note Equals ""');
      expect(result).toEqual([{ key: 'note', operator: 'Equals', value: { stringValue: '' } }]);
    });

    it('preserves multi-word bare values verbatim', () => {
      const result = parseFiltersInput('label Contains hello world');
      expect(result).toEqual([
        { key: 'label', operator: 'Contains', value: { stringValue: 'hello world' } },
      ]);
    });
  });

  describe('operator handling', () => {
    it('accepts every supported operator', () => {
      const operators = [
        'Equals',
        'NotEquals',
        'GreaterThan',
        'LessThan',
        'GreaterThanOrEqual',
        'LessThanOrEqual',
        'Contains',
        'NotContains',
      ];
      for (const op of operators) {
        const result = parseFiltersInput(`k ${op} v`);
        expect(result, `operator ${op}`).toEqual([
          { key: 'k', operator: op, value: { stringValue: 'v' } },
        ]);
      }
    });

    it('returns undefined when the operator is unknown', () => {
      expect(parseFiltersInput('k FooBar v')).toBeUndefined();
    });

    it('is case-sensitive on operator names', () => {
      expect(parseFiltersInput('k equals v')).toBeUndefined();
    });
  });

  describe('segment splitting', () => {
    it('splits on ";" and trims each segment', () => {
      const result = parseFiltersInput('  a Equals 1 ;  b NotEquals 2  ');
      expect(result).toEqual([
        { key: 'a', operator: 'Equals', value: { doubleValue: 1 } },
        { key: 'b', operator: 'NotEquals', value: { doubleValue: 2 } },
      ]);
    });

    it('ignores empty segments produced by trailing or doubled ";"', () => {
      const result = parseFiltersInput('a Equals 1;;b Equals 2;');
      expect(result).toHaveLength(2);
    });

    it('returns undefined when input has no non-empty segments', () => {
      expect(parseFiltersInput('')).toBeUndefined();
      expect(parseFiltersInput('   ;;  ')).toBeUndefined();
    });
  });

  describe('failure modes', () => {
    it('returns undefined when a segment has fewer than three parts', () => {
      expect(parseFiltersInput('onlykey')).toBeUndefined();
      expect(parseFiltersInput('key Equals')).toBeUndefined();
    });

    it('returns undefined when any segment in a list is malformed', () => {
      // First segment is fine; second is missing the value.
      expect(parseFiltersInput('a Equals 1; b Equals')).toBeUndefined();
    });
  });
});

describe('formatFilter', () => {
  it('renders string values', () => {
    expect(
      formatFilter({ key: 'model', operator: 'Equals', value: { stringValue: 'claude-3' } })
    ).toBe('model Equals claude-3');
  });

  it('renders double values', () => {
    expect(
      formatFilter({ key: 'latencyMs', operator: 'LessThan', value: { doubleValue: 1000 } })
    ).toBe('latencyMs LessThan 1000');
  });

  it('renders boolean values', () => {
    expect(
      formatFilter({ key: 'success', operator: 'Equals', value: { booleanValue: true } })
    ).toBe('success Equals true');
  });
});
