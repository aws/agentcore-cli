import { getBundleNameVariants } from '../bundle-name-variants';
import { describe, expect, it } from 'vitest';

describe('getBundleNameVariants', () => {
  it('returns only the bundle name when no project name', () => {
    expect(getBundleNameVariants('MyBundle')).toEqual(['MyBundle']);
  });

  it('returns only the bundle name when project name is undefined', () => {
    expect(getBundleNameVariants('MyBundle', undefined)).toEqual(['MyBundle']);
  });

  it('returns three variants when project name is provided', () => {
    const variants = getBundleNameVariants('MyBundle', 'testevo');
    expect(variants).toEqual(['MyBundle', 'testevoMyBundle', 'testevo_MyBundle']);
  });

  it('filters out empty bundle name', () => {
    const variants = getBundleNameVariants('', 'proj');
    expect(variants).toEqual(['proj', 'proj_']);
  });
});
