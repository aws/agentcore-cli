import { describe, it } from 'bun:test';
import assert from 'node:assert';
import { compareVersions } from './action.js';

describe('update', () => {
  describe('compareVersions', () => {
    it('returns 0 for equal versions', () => {
      assert.strictEqual(compareVersions('1.0.0', '1.0.0'), 0);
      assert.strictEqual(compareVersions('2.5.3', '2.5.3'), 0);
    });

    it('returns 1 when latest is newer (update available)', () => {
      assert.strictEqual(compareVersions('1.0.0', '1.0.1'), 1);
      assert.strictEqual(compareVersions('1.0.0', '1.1.0'), 1);
      assert.strictEqual(compareVersions('1.0.0', '2.0.0'), 1);
      assert.strictEqual(compareVersions('1.9.9', '2.0.0'), 1);
    });

    it('returns -1 when current is newer (local ahead)', () => {
      assert.strictEqual(compareVersions('1.0.1', '1.0.0'), -1);
      assert.strictEqual(compareVersions('1.1.0', '1.0.0'), -1);
      assert.strictEqual(compareVersions('2.0.0', '1.0.0'), -1);
      assert.strictEqual(compareVersions('2.0.0', '1.9.9'), -1);
    });

    it('handles missing patch version', () => {
      assert.strictEqual(compareVersions('1.0', '1.0.0'), 0);
      assert.strictEqual(compareVersions('1.0.0', '1.0'), 0);
      assert.strictEqual(compareVersions('1.0', '1.0.1'), 1);
    });

    it('compares major version first', () => {
      assert.strictEqual(compareVersions('1.9.9', '2.0.0'), 1);
      assert.strictEqual(compareVersions('2.0.0', '1.9.9'), -1);
    });
  });
});
