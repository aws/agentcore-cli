import type { Result } from '../../../lib/result';
import { BasePrimitive } from '../BasePrimitive';
import type { AddResult, AddScreenComponent, RemovableResource, RemovalPreview } from '../types';
import type { Command } from '@commander-js/extra-typings';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

/** Concrete stub to test BasePrimitive contract and helpers */
class StubPrimitive extends BasePrimitive {
  readonly kind = 'agent' as const;
  readonly label = 'Stub';
  readonly primitiveSchema = z.object({ name: z.string() });

  add(_options: Record<string, unknown>): Promise<AddResult> {
    return Promise.resolve({ success: true });
  }

  remove(_name: string): Promise<Result> {
    return Promise.resolve({ success: true });
  }

  previewRemove(_name: string): Promise<RemovalPreview> {
    return Promise.resolve({ summary: [], directoriesToDelete: [], schemaChanges: [] });
  }

  getRemovable(): Promise<RemovableResource[]> {
    return Promise.resolve([]);
  }

  registerCommands(_addCmd: Command, _removeCmd: Command): void {
    // no-op
  }

  addScreen(): AddScreenComponent {
    return null;
  }

  // Expose protected methods for testing
  public testCheckDuplicate(items: { name: string }[], name: string, label?: string): void {
    this.checkDuplicate(items, name, label);
  }
}

describe('BasePrimitive', () => {
  const primitive = new StubPrimitive();

  it('exposes kind and label', () => {
    expect(primitive.kind).toBe('agent');
    expect(primitive.label).toBe('Stub');
  });

  it('exposes primitiveSchema', () => {
    const result = primitive.primitiveSchema.safeParse({ name: 'test' });
    expect(result.success).toBe(true);
  });

  describe('checkDuplicate', () => {
    it('does not throw when no duplicate', () => {
      expect(() => primitive.testCheckDuplicate([{ name: 'a' }], 'b')).not.toThrow();
    });

    it('throws when duplicate found', () => {
      expect(() => primitive.testCheckDuplicate([{ name: 'a' }], 'a')).toThrow('Stub "a" already exists.');
    });

    it('uses custom label in error message', () => {
      expect(() => primitive.testCheckDuplicate([{ name: 'x' }], 'x', 'Memory')).toThrow('Memory "x" already exists.');
    });
  });

  describe('abstract methods', () => {
    it('add returns success', async () => {
      const result = await primitive.add({});
      expect(result.success).toBe(true);
    });

    it('remove returns success', async () => {
      const result = await primitive.remove('test');
      expect(result).toEqual({ success: true });
    });

    it('previewRemove returns empty preview', async () => {
      const result = await primitive.previewRemove('test');
      expect(result).toEqual({ summary: [], directoriesToDelete: [], schemaChanges: [] });
    });

    it('getRemovable returns empty array', async () => {
      const result = await primitive.getRemovable();
      expect(result).toEqual([]);
    });

    it('addScreen returns null', () => {
      expect(primitive.addScreen()).toBeNull();
    });
  });
});
