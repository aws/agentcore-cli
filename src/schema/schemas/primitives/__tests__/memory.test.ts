import { DEFAULT_STRATEGY_NAMESPACES, MemoryStrategySchema, MemoryStrategyTypeSchema } from '../memory';
import { describe, expect, it } from 'vitest';

describe('MemoryStrategyTypeSchema', () => {
  describe('valid strategy types', () => {
    it('accepts SEMANTIC', () => {
      expect(MemoryStrategyTypeSchema.safeParse('SEMANTIC').success).toBe(true);
    });

    it('accepts SUMMARIZATION', () => {
      expect(MemoryStrategyTypeSchema.safeParse('SUMMARIZATION').success).toBe(true);
    });

    it('accepts USER_PREFERENCE', () => {
      expect(MemoryStrategyTypeSchema.safeParse('USER_PREFERENCE').success).toBe(true);
    });
  });

  describe('invalid strategy types', () => {
    // Issue #235: CUSTOM strategy has been removed
    it('rejects CUSTOM strategy', () => {
      const result = MemoryStrategyTypeSchema.safeParse('CUSTOM');
      expect(result.success).toBe(false);
    });

    it('rejects arbitrary invalid strategies', () => {
      expect(MemoryStrategyTypeSchema.safeParse('INVALID').success).toBe(false);
      expect(MemoryStrategyTypeSchema.safeParse('').success).toBe(false);
      expect(MemoryStrategyTypeSchema.safeParse('semantic').success).toBe(false); // lowercase
    });
  });

  describe('schema options', () => {
    it('only contains three valid strategies', () => {
      expect(MemoryStrategyTypeSchema.options).toEqual(['SEMANTIC', 'SUMMARIZATION', 'USER_PREFERENCE']);
      expect(MemoryStrategyTypeSchema.options).not.toContain('CUSTOM');
    });
  });
});

describe('MemoryStrategySchema', () => {
  it('validates strategy with required type field', () => {
    const result = MemoryStrategySchema.safeParse({ type: 'SEMANTIC' });
    expect(result.success).toBe(true);
  });

  it('validates strategy with optional fields', () => {
    const result = MemoryStrategySchema.safeParse({
      type: 'SEMANTIC',
      name: 'myStrategy',
      description: 'A description',
      namespaces: ['/users/{actorId}/facts'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects strategy with CUSTOM type', () => {
    const result = MemoryStrategySchema.safeParse({ type: 'CUSTOM' });
    expect(result.success).toBe(false);
  });

  it('rejects strategy with invalid type', () => {
    const result = MemoryStrategySchema.safeParse({ type: 'INVALID' });
    expect(result.success).toBe(false);
  });

  it('rejects strategy without type', () => {
    const result = MemoryStrategySchema.safeParse({ name: 'myStrategy' });
    expect(result.success).toBe(false);
  });
});

describe('DEFAULT_STRATEGY_NAMESPACES', () => {
  it('has default namespaces for SEMANTIC', () => {
    expect(DEFAULT_STRATEGY_NAMESPACES.SEMANTIC).toEqual(['/users/{actorId}/facts']);
  });

  it('has default namespaces for USER_PREFERENCE', () => {
    expect(DEFAULT_STRATEGY_NAMESPACES.USER_PREFERENCE).toEqual(['/users/{actorId}/preferences']);
  });

  it('has default namespaces for SUMMARIZATION', () => {
    expect(DEFAULT_STRATEGY_NAMESPACES.SUMMARIZATION).toEqual(['/summaries/{actorId}/{sessionId}']);
  });

  it('does not have default namespaces for CUSTOM (removed)', () => {
    expect(DEFAULT_STRATEGY_NAMESPACES).not.toHaveProperty('CUSTOM');
  });
});
