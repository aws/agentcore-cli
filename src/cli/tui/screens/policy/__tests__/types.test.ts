import { invalidFiltersForCategory } from '../types.js';
import { describe, expect, it } from 'vitest';

describe('invalidFiltersForCategory', () => {
  it('returns an empty array when every filter is valid for the category', () => {
    expect(invalidFiltersForCategory('contentFilter', ['VIOLENCE', 'INSULTS'])).toEqual([]);
    expect(invalidFiltersForCategory('promptAttack', ['JAILBREAK'])).toEqual([]);
    expect(invalidFiltersForCategory('sensitiveInformation', ['EMAIL', 'PHONE'])).toEqual([]);
  });

  it('rejects an unknown filter value', () => {
    expect(invalidFiltersForCategory('contentFilter', ['VIOLENCE', 'NOTAREAL'])).toEqual(['NOTAREAL']);
  });

  it('rejects the legacy singular INSULT (regression guard for #1571)', () => {
    expect(invalidFiltersForCategory('contentFilter', ['INSULT'])).toEqual(['INSULT']);
    expect(invalidFiltersForCategory('contentFilter', ['INSULTS'])).toEqual([]);
  });
});
