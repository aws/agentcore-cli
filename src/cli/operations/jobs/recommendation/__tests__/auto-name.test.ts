import { RECOMMENDATION_NAME_REGEX } from '../../shared/constants';
import { autoRecommendationName } from '../handler';
import { describe, expect, it } from 'vitest';

const FIXED_NOW = 1781546192034; // 13-digit ms timestamp

describe('autoRecommendationName', () => {
  it('caps long project/agent names to the 48-char service limit (regression: AfricanTripPlanner)', () => {
    const name = autoRecommendationName('AfricanTripPlanner', 'AfricanTripPlanner', FIXED_NOW);
    expect(name.length).toBeLessThanOrEqual(48);
    expect(RECOMMENDATION_NAME_REGEX.test(name)).toBe(true);
    // The full timestamp is preserved as the suffix for uniqueness.
    expect(name.endsWith(`_${FIXED_NOW}`)).toBe(true);
  });

  it('leaves short names intact', () => {
    const name = autoRecommendationName('Trip', 'Planner', FIXED_NOW);
    expect(name).toBe(`Trip_Planner_${FIXED_NOW}`);
    expect(RECOMMENDATION_NAME_REGEX.test(name)).toBe(true);
  });

  it('produces a valid name even when the prefix would start with a non-letter', () => {
    const name = autoRecommendationName('123proj', 'agent', FIXED_NOW);
    expect(RECOMMENDATION_NAME_REGEX.test(name)).toBe(true);
    expect(/^[a-zA-Z]/.test(name)).toBe(true);
  });

  it('sanitizes characters the service regex forbids', () => {
    const name = autoRecommendationName('my proj.name', 'my/agent', FIXED_NOW);
    expect(RECOMMENDATION_NAME_REGEX.test(name)).toBe(true);
    expect(name).not.toMatch(/[ ./]/);
  });

  it('stays within 48 chars for very long inputs', () => {
    const name = autoRecommendationName('VeryLongProjectNameThatExceedsLimits', 'AndAVeryLongAgentNameToo', FIXED_NOW);
    expect(name.length).toBeLessThanOrEqual(48);
    expect(RECOMMENDATION_NAME_REGEX.test(name)).toBe(true);
  });
});
