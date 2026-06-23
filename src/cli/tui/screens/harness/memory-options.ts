import type { AddHarnessConfig } from './types';

/**
 * The subset of `HarnessPrimitive.add` options that describe memory. Returned by
 * {@link toMemoryAddOptions} and spread into the primitive's `add()` call.
 */
export interface MemoryAddOptions {
  memoryMode: 'managed' | 'existing' | 'disabled';
  memoryName?: string;
  memoryArn?: string;
  memoryActorId?: string;
  messagesCount?: number;
  memoryTopK?: number;
  memoryRelevanceScore?: number;
  memoryStrategies?: string[];
  memoryEventExpiryDays?: number;
  memoryEncryptionKeyArn?: string;
}

/**
 * Translate the wizard's mode-tagged memory union (`AddHarnessConfig['memory']`) into the flat
 * `HarnessPrimitive.add` memory options. Single source of truth shared by the add-harness flow and
 * the create flow so the two can't drift — a past drift silently dropped existing-mode retrieval
 * tuning because one reader pulled tuning from the union while the wizard wrote it to flat fields.
 *
 * The wizard always seeds a memory mode (managed default), so an absent/unknown mode falls through
 * to managed.
 */
export function toMemoryAddOptions(memory: AddHarnessConfig['memory']): MemoryAddOptions {
  if (memory?.mode === 'existing') {
    return {
      memoryMode: 'existing',
      memoryName: memory.name,
      memoryArn: memory.arn,
      memoryActorId: memory.actorId,
      messagesCount: memory.messagesCount,
      memoryTopK: memory.topK,
      memoryRelevanceScore: memory.relevanceScore,
    };
  }
  if (memory?.mode === 'disabled') {
    return { memoryMode: 'disabled' };
  }
  return {
    memoryMode: 'managed',
    memoryStrategies: memory?.mode === 'managed' ? memory.strategies : undefined,
    memoryEventExpiryDays: memory?.mode === 'managed' ? memory.eventExpiryDuration : undefined,
    memoryEncryptionKeyArn: memory?.mode === 'managed' ? memory.encryptionKeyArn : undefined,
  };
}
