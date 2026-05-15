import {
  DEFAULT_EPISODIC_REFLECTION_NAMESPACES,
  DEFAULT_EPISODIC_REFLECTION_NAMESPACE_TEMPLATES,
  DEFAULT_STRATEGY_NAMESPACES,
  DEFAULT_STRATEGY_NAMESPACE_TEMPLATES,
  MemoryStrategySchema,
  MemoryStrategyTypeSchema,
} from '../memory';
import { describe, expect, it } from 'vitest';

describe('MemoryStrategyTypeSchema', () => {
  it('accepts valid strategy types and rejects invalid', () => {
    expect(MemoryStrategyTypeSchema.safeParse('SEMANTIC').success).toBe(true);
    expect(MemoryStrategyTypeSchema.safeParse('EPISODIC').success).toBe(true);
    expect(MemoryStrategyTypeSchema.safeParse('CUSTOM').success).toBe(false);
    expect(MemoryStrategyTypeSchema.safeParse('semantic').success).toBe(false);
  });

  it('contains four valid strategies including EPISODIC', () => {
    expect(MemoryStrategyTypeSchema.options).toEqual(['SEMANTIC', 'SUMMARIZATION', 'USER_PREFERENCE', 'EPISODIC']);
    expect(MemoryStrategyTypeSchema.options).not.toContain('CUSTOM');
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
      namespaceTemplates: ['/users/{actorId}/facts'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts deprecated namespaces field as backward-compat alias', () => {
    const result = MemoryStrategySchema.safeParse({
      type: 'SEMANTIC',
      namespaces: ['/users/{actorId}/facts'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects strategy specifying both namespaces and namespaceTemplates', () => {
    const result = MemoryStrategySchema.safeParse({
      type: 'SEMANTIC',
      namespaces: ['/users/{actorId}/facts'],
      namespaceTemplates: ['/users/{actorId}/facts'],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('mutually exclusive');
    }
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

  it('accepts EPISODIC strategy with reflectionNamespaceTemplates', () => {
    const result = MemoryStrategySchema.safeParse({
      type: 'EPISODIC',
      namespaceTemplates: ['/episodes/{actorId}/{sessionId}'],
      reflectionNamespaceTemplates: ['/episodes/{actorId}'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts EPISODIC strategy with deprecated reflectionNamespaces alias', () => {
    const result = MemoryStrategySchema.safeParse({
      type: 'EPISODIC',
      namespaces: ['/episodes/{actorId}/{sessionId}'],
      reflectionNamespaces: ['/episodes/{actorId}'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects EPISODIC strategy specifying both reflectionNamespaces and reflectionNamespaceTemplates', () => {
    const result = MemoryStrategySchema.safeParse({
      type: 'EPISODIC',
      namespaceTemplates: ['/episodes/{actorId}/{sessionId}'],
      reflectionNamespaces: ['/episodes/{actorId}'],
      reflectionNamespaceTemplates: ['/episodes/{actorId}'],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('mutually exclusive'))).toBe(true);
    }
  });

  it('rejects EPISODIC strategy without reflectionNamespaceTemplates', () => {
    const result = MemoryStrategySchema.safeParse({
      type: 'EPISODIC',
      namespaceTemplates: ['/episodes/{actorId}/{sessionId}'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects EPISODIC strategy with empty reflectionNamespaceTemplates', () => {
    const result = MemoryStrategySchema.safeParse({
      type: 'EPISODIC',
      namespaceTemplates: ['/episodes/{actorId}/{sessionId}'],
      reflectionNamespaceTemplates: [],
    });
    expect(result.success).toBe(false);
  });

  it('allows non-EPISODIC strategies without reflectionNamespaceTemplates', () => {
    const result = MemoryStrategySchema.safeParse({ type: 'SEMANTIC' });
    expect(result.success).toBe(true);
  });

  it('rejects EPISODIC when reflectionNamespaceTemplates is not a prefix of namespaceTemplates', () => {
    const result = MemoryStrategySchema.safeParse({
      type: 'EPISODIC',
      namespaceTemplates: ['/episodes/{actorId}/{sessionId}'],
      reflectionNamespaceTemplates: ['/reflections/{actorId}'],
    });
    expect(result.success).toBe(false);
  });

  it('accepts EPISODIC when reflectionNamespaceTemplates is a prefix of namespaceTemplates', () => {
    const result = MemoryStrategySchema.safeParse({
      type: 'EPISODIC',
      namespaceTemplates: ['/episodes/{actorId}/{sessionId}'],
      reflectionNamespaceTemplates: ['/episodes/{actorId}'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts EPISODIC when reflectionNamespaceTemplates equals namespaceTemplates', () => {
    const result = MemoryStrategySchema.safeParse({
      type: 'EPISODIC',
      namespaceTemplates: ['/episodes/{actorId}/{sessionId}'],
      reflectionNamespaceTemplates: ['/episodes/{actorId}/{sessionId}'],
    });
    expect(result.success).toBe(true);
  });

  it('evaluates prefix refinement using deprecated aliases when only they are provided', () => {
    const result = MemoryStrategySchema.safeParse({
      type: 'EPISODIC',
      namespaces: ['/episodes/{actorId}/{sessionId}'],
      reflectionNamespaces: ['/reflections/{actorId}'],
    });
    expect(result.success).toBe(false);
  });
});

describe('DEFAULT_STRATEGY_NAMESPACE_TEMPLATES', () => {
  it('has default templates for SEMANTIC', () => {
    expect(DEFAULT_STRATEGY_NAMESPACE_TEMPLATES.SEMANTIC).toEqual(['/users/{actorId}/facts']);
  });

  it('has default templates for USER_PREFERENCE', () => {
    expect(DEFAULT_STRATEGY_NAMESPACE_TEMPLATES.USER_PREFERENCE).toEqual(['/users/{actorId}/preferences']);
  });

  it('has default templates for SUMMARIZATION', () => {
    expect(DEFAULT_STRATEGY_NAMESPACE_TEMPLATES.SUMMARIZATION).toEqual(['/summaries/{actorId}/{sessionId}']);
  });

  it('has default templates for EPISODIC', () => {
    expect(DEFAULT_STRATEGY_NAMESPACE_TEMPLATES.EPISODIC).toEqual(['/episodes/{actorId}/{sessionId}']);
  });

  it('does not have default templates for CUSTOM (removed)', () => {
    expect(DEFAULT_STRATEGY_NAMESPACE_TEMPLATES).not.toHaveProperty('CUSTOM');
  });

  it('deprecated alias DEFAULT_STRATEGY_NAMESPACES points to the same object', () => {
    expect(DEFAULT_STRATEGY_NAMESPACES).toBe(DEFAULT_STRATEGY_NAMESPACE_TEMPLATES);
  });

  it('deprecated alias DEFAULT_EPISODIC_REFLECTION_NAMESPACES points to the same object', () => {
    expect(DEFAULT_EPISODIC_REFLECTION_NAMESPACES).toBe(DEFAULT_EPISODIC_REFLECTION_NAMESPACE_TEMPLATES);
  });
});
