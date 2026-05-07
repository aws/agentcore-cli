import { parseFiltersInput } from '../parseFiltersInput';
import { describe, expect, it } from 'vitest';

describe('parseFiltersInput', () => {
  it('returns an empty array for empty input', () => {
    expect(parseFiltersInput('')).toEqual([]);
    expect(parseFiltersInput('   ')).toEqual([]);
  });

  it('returns an error for invalid JSON', () => {
    expect(parseFiltersInput('not json')).toBe('Invalid JSON');
  });

  it('rejects a JSON object (not array)', () => {
    expect(parseFiltersInput('{"key":"x","operator":"Equals","value":{"stringValue":"y"}}')).toBe(
      'Must be a JSON array of filter objects'
    );
  });

  it('rejects array with non-object element', () => {
    expect(parseFiltersInput('["not an object"]')).toBe('Each filter must be an object');
  });

  it('rejects filter missing key', () => {
    expect(parseFiltersInput('[{"operator":"Equals","value":{"stringValue":"y"}}]')).toBe(
      'Each filter requires a non-empty "key" string'
    );
  });

  it('rejects filter with empty key', () => {
    expect(parseFiltersInput('[{"key":"","operator":"Equals","value":{"stringValue":"y"}}]')).toBe(
      'Each filter requires a non-empty "key" string'
    );
  });

  it('rejects filter with unknown operator', () => {
    const out = parseFiltersInput('[{"key":"k","operator":"EQUALS","value":{"stringValue":"y"}}]');
    expect(typeof out).toBe('string');
    expect(out as string).toContain('operator must be one of');
  });

  it('rejects filter missing value', () => {
    expect(parseFiltersInput('[{"key":"k","operator":"Equals"}]')).toBe('Each filter requires a "value" object');
  });

  it('rejects value with zero branches set', () => {
    expect(parseFiltersInput('[{"key":"k","operator":"Equals","value":{}}]')).toBe(
      'Filter value must have exactly one of stringValue, doubleValue, booleanValue'
    );
  });

  it('rejects value with two branches set', () => {
    expect(parseFiltersInput('[{"key":"k","operator":"Equals","value":{"stringValue":"x","doubleValue":1}}]')).toBe(
      'Filter value must have exactly one of stringValue, doubleValue, booleanValue'
    );
  });

  it('rejects value with three branches set', () => {
    expect(
      parseFiltersInput(
        '[{"key":"k","operator":"Equals","value":{"stringValue":"x","doubleValue":1,"booleanValue":true}}]'
      )
    ).toBe('Filter value must have exactly one of stringValue, doubleValue, booleanValue');
  });

  it('parses a multi-filter happy path covering all three value types', () => {
    const json = JSON.stringify([
      { key: 'user.id', operator: 'Equals', value: { stringValue: 'abc' } },
      { key: 'score', operator: 'GreaterThan', value: { doubleValue: 0.5 } },
      { key: 'flagged', operator: 'NotEquals', value: { booleanValue: true } },
    ]);
    const out = parseFiltersInput(json);
    expect(Array.isArray(out)).toBe(true);
    expect(out).toEqual([
      { key: 'user.id', operator: 'Equals', value: { stringValue: 'abc' } },
      { key: 'score', operator: 'GreaterThan', value: { doubleValue: 0.5 } },
      { key: 'flagged', operator: 'NotEquals', value: { booleanValue: true } },
    ]);
  });
});
