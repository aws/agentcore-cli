import { ADVANCED_SETTING_OPTIONS } from '../types';
import { describe, expect, it } from 'vitest';

// Guards a real regression: capacityProvider was added to this shared list AND separately
// inserted by the BYO screen's byoAdvancedItems, so it rendered twice (duplicate React key).
// byoAdvancedItems and the generate wizard both derive their menu from this list, so unique
// ids here is the invariant that keeps either menu from showing a duplicate option.
describe('ADVANCED_SETTING_OPTIONS', () => {
  it('has unique ids', () => {
    const ids = ADVANCED_SETTING_OPTIONS.map(o => o.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('includes capacityProvider exactly once', () => {
    expect(ADVANCED_SETTING_OPTIONS.filter(o => o.id === 'capacityProvider')).toHaveLength(1);
  });
});
