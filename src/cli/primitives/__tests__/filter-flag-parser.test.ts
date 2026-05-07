import { parseFilterFlag, parseFilterFlags } from '../filter-flag-parser';
import { describe, expect, it } from 'vitest';

describe('parseFilterFlag', () => {
  it('parses a string filter', () => {
    expect(parseFilterFlag('key=userId,op=Equals,type=string,value=abc')).toEqual({
      key: 'userId',
      operator: 'Equals',
      value: { stringValue: 'abc' },
    });
  });

  it('parses a double filter', () => {
    expect(parseFilterFlag('key=score,op=GreaterThan,type=double,value=0.75')).toEqual({
      key: 'score',
      operator: 'GreaterThan',
      value: { doubleValue: 0.75 },
    });
  });

  it('parses a boolean filter (true)', () => {
    expect(parseFilterFlag('key=isPremium,op=Equals,type=boolean,value=true')).toEqual({
      key: 'isPremium',
      operator: 'Equals',
      value: { booleanValue: true },
    });
  });

  it('parses a boolean filter (false)', () => {
    expect(parseFilterFlag('key=isPremium,op=NotEquals,type=boolean,value=false')).toEqual({
      key: 'isPremium',
      operator: 'NotEquals',
      value: { booleanValue: false },
    });
  });

  it('keeps "true" as a string when type=string', () => {
    expect(parseFilterFlag('key=k,op=Equals,type=string,value=true')).toEqual({
      key: 'k',
      operator: 'Equals',
      value: { stringValue: 'true' },
    });
  });

  it('accepts fields in any order', () => {
    expect(parseFilterFlag('value=abc,type=string,op=Contains,key=label')).toEqual({
      key: 'label',
      operator: 'Contains',
      value: { stringValue: 'abc' },
    });
  });

  it('throws on unknown operator', () => {
    expect(() => parseFilterFlag('key=k,op=StartsWith,type=string,value=x')).toThrow(/op/);
  });

  it('throws on unknown type', () => {
    expect(() => parseFilterFlag('key=k,op=Equals,type=int,value=1')).toThrow(/type/);
  });

  it('throws on missing required field', () => {
    expect(() => parseFilterFlag('key=k,op=Equals,type=string')).toThrow(/value/);
  });

  it('throws on duplicate keys', () => {
    expect(() => parseFilterFlag('key=k,key=other,op=Equals,type=string,value=v')).toThrow(/Duplicate/);
  });

  it('throws on invalid double value', () => {
    expect(() => parseFilterFlag('key=k,op=Equals,type=double,value=notanumber')).toThrow(/double/);
  });

  it('throws on invalid boolean value', () => {
    expect(() => parseFilterFlag('key=k,op=Equals,type=boolean,value=yes')).toThrow(/boolean/);
  });

  it('throws on empty input', () => {
    expect(() => parseFilterFlag('')).toThrow();
    expect(() => parseFilterFlag('   ')).toThrow();
  });

  it('throws on syntactic garbage', () => {
    expect(() => parseFilterFlag('not_a_kv_pair')).toThrow();
  });
});

describe('parseFilterFlags', () => {
  it('returns undefined for missing/empty input', () => {
    expect(parseFilterFlags(undefined)).toBeUndefined();
    expect(parseFilterFlags([])).toBeUndefined();
  });

  it('parses multiple filters', () => {
    const out = parseFilterFlags(['key=a,op=Equals,type=string,value=x', 'key=b,op=GreaterThan,type=double,value=2']);
    expect(out).toHaveLength(2);
    expect(out![0]!.key).toBe('a');
    expect(out![1]!.value).toEqual({ doubleValue: 2 });
  });
});
