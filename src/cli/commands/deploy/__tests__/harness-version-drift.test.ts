import { computeHarnessVersionDrift } from '../actions.js';
import { describe, expect, it } from 'vitest';

describe('computeHarnessVersionDrift', () => {
  it('reports a first deploy (no prior version) as deployed at the new version', () => {
    const notes = computeHarnessVersionDrift(undefined, { h1: { harnessVersion: 1 } });
    expect(notes).toEqual([{ name: 'h1', from: undefined, to: 1 }]);
  });

  it('reports a version bump as from → to', () => {
    const notes = computeHarnessVersionDrift({ h1: { harnessVersion: 2 } }, { h1: { harnessVersion: 3 } });
    expect(notes).toEqual([{ name: 'h1', from: 2, to: 3 }]);
  });

  it('emits no note when the version is unchanged', () => {
    const notes = computeHarnessVersionDrift({ h1: { harnessVersion: 3 } }, { h1: { harnessVersion: 3 } });
    expect(notes).toEqual([]);
  });

  it('skips harnesses that emit no version (legacy stack)', () => {
    const notes = computeHarnessVersionDrift(undefined, { h1: {} });
    expect(notes).toEqual([]);
  });

  it('handles multiple harnesses independently', () => {
    const notes = computeHarnessVersionDrift(
      { a: { harnessVersion: 1 }, b: { harnessVersion: 5 } },
      { a: { harnessVersion: 2 }, b: { harnessVersion: 5 }, c: { harnessVersion: 1 } }
    );
    expect(notes).toEqual([
      { name: 'a', from: 1, to: 2 },
      { name: 'c', from: undefined, to: 1 },
    ]);
  });
});
