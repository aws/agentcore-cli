import { CONTENT_FILTER_FILTERS, FILTERS_BY_CATEGORY, invalidFiltersForCategory } from '../types.js';
import { describe, expect, it } from 'vitest';

describe('CONTENT_FILTER_FILTERS', () => {
  it('uses the canonical plural INSULTS, not the singular INSULT', () => {
    expect(CONTENT_FILTER_FILTERS).toContain('INSULTS');
    expect(CONTENT_FILTER_FILTERS).not.toContain('INSULT');
  });
});

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

  it('rejects a filter from a different category', () => {
    // JAILBREAK is valid for promptAttack but not for contentFilter
    expect(invalidFiltersForCategory('contentFilter', ['JAILBREAK'])).toEqual(['JAILBREAK']);
  });

  it('exposes the allowed filters per category', () => {
    expect(FILTERS_BY_CATEGORY.contentFilter).toBe(CONTENT_FILTER_FILTERS);
    expect(FILTERS_BY_CATEGORY.promptAttack.length).toBeGreaterThan(0);
    expect(FILTERS_BY_CATEGORY.sensitiveInformation.length).toBeGreaterThan(0);
  });
});
