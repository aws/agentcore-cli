import { describe, it } from 'bun:test';
import assert from 'node:assert';
import { z } from 'zod';
import { uniqueBy } from './zod-util.js';

describe('zod-util', () => {
  describe('uniqueBy', () => {
    // Helper schema for testing
    const createSchema = (errorMsg: (key: string) => string = (k) => `Duplicate: ${k}`) =>
      z.array(z.object({ name: z.string() })).superRefine(uniqueBy((x) => x.name, errorMsg));

    // AC1: Unique array passes validation
    it('passes validation for unique arrays', () => {
      const schema = createSchema();
      const result = schema.safeParse([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
      assert.strictEqual(result.success, true);
    });

    // AC2: Duplicate detected at correct index (NOT first occurrence)
    it('detects duplicate at correct index', () => {
      const schema = createSchema();
      const result = schema.safeParse([{ name: 'a' }, { name: 'b' }, { name: 'a' }]);
      assert.strictEqual(result.success, false);
      if (!result.success) {
        assert.strictEqual(result.error.issues.length, 1);
        assert.deepStrictEqual(result.error.issues[0].path, [2]);
      }
    });

    // AC3: Custom error message used
    it('uses custom error message', () => {
      const schema = createSchema((key) => `Duplicate name: ${key}`);
      const result = schema.safeParse([{ name: 'foo' }, { name: 'foo' }]);
      assert.strictEqual(result.success, false);
      if (!result.success) {
        assert.strictEqual(result.error.issues[0].message, 'Duplicate name: foo');
      }
    });

    // AC4: Empty array passes
    it('passes validation for empty array', () => {
      const schema = createSchema();
      const result = schema.safeParse([]);
      assert.strictEqual(result.success, true);
    });

    // AC5: Single element passes
    it('passes validation for single element', () => {
      const schema = createSchema();
      const result = schema.safeParse([{ name: 'a' }]);
      assert.strictEqual(result.success, true);
    });

    // AC6: Multiple duplicates of same key flagged at each occurrence
    it('flags multiple duplicates at each subsequent occurrence', () => {
      const schema = createSchema();
      const result = schema.safeParse([
        { name: 'a' },  // index 0 - first, not flagged
        { name: 'b' },  // index 1 - unique
        { name: 'a' },  // index 2 - duplicate, flagged
        { name: 'c' },  // index 3 - unique
        { name: 'a' },  // index 4 - duplicate, flagged
      ]);
      assert.strictEqual(result.success, false);
      if (!result.success) {
        assert.strictEqual(result.error.issues.length, 2);
        const paths = result.error.issues.map((i) => i.path[0]);
        assert.ok(paths.includes(2), 'Should flag index 2');
        assert.ok(paths.includes(4), 'Should flag index 4');
        assert.ok(!paths.includes(0), 'Should NOT flag index 0 (first occurrence)');
      }
    });

    // AC7: First occurrence is never flagged
    it('never flags first occurrence', () => {
      const schema = createSchema();
      const result = schema.safeParse([{ name: 'a' }, { name: 'a' }]);
      assert.strictEqual(result.success, false);
      if (!result.success) {
        const paths = result.error.issues.map((i) => i.path[0]);
        assert.ok(!paths.includes(0), 'First occurrence should not be flagged');
        assert.ok(paths.includes(1), 'Second occurrence should be flagged');
      }
    });

    // AC8: Different key functions work
    it('works with different key functions', () => {
      const idSchema = z
        .array(z.object({ id: z.string() }))
        .superRefine(uniqueBy((x) => x.id, (k) => `Duplicate id: ${k}`));

      const result = idSchema.safeParse([{ id: '1' }, { id: '2' }, { id: '1' }]);
      assert.strictEqual(result.success, false);
      if (!result.success) {
        assert.strictEqual(result.error.issues.length, 1);
        assert.deepStrictEqual(result.error.issues[0].path, [2]);
        assert.strictEqual(result.error.issues[0].message, 'Duplicate id: 1');
      }
    });

    // AC9: All elements same key
    it('flags all subsequent occurrences when all elements have same key', () => {
      const schema = createSchema();
      const result = schema.safeParse([{ name: 'a' }, { name: 'a' }, { name: 'a' }]);
      assert.strictEqual(result.success, false);
      if (!result.success) {
        assert.strictEqual(result.error.issues.length, 2);
        const paths = result.error.issues.map((i) => i.path[0]);
        assert.ok(!paths.includes(0), 'Index 0 should NOT be flagged');
        assert.ok(paths.includes(1), 'Index 1 should be flagged');
        assert.ok(paths.includes(2), 'Index 2 should be flagged');
      }
    });
  });
});
