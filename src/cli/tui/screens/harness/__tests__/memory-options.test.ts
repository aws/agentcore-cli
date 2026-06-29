import { toMemoryAddOptions } from '../memory-options';
import type { AddHarnessConfig } from '../types';
import { describe, expect, it } from 'vitest';

// Regression guard: the wizard's existing-tuning setters write into the `existing` union arm, and
// this translation must READ them from the same arm. A prior drift (setters wrote flat fields, the
// translation read the union) silently dropped messagesCount/topK/relevanceScore entered in the TUI.

describe('toMemoryAddOptions', () => {
  it('maps managed (with tuning) to managed add-options', () => {
    const memory: AddHarnessConfig['memory'] = {
      mode: 'managed',
      strategies: ['SEMANTIC', 'SUMMARIZATION'],
      eventExpiryDuration: 45,
      encryptionKeyArn: 'arn:aws:kms:us-west-2:1:key/abc',
    };
    expect(toMemoryAddOptions(memory)).toEqual({
      memoryMode: 'managed',
      memoryStrategies: ['SEMANTIC', 'SUMMARIZATION'],
      memoryEventExpiryDays: 45,
      memoryEncryptionKeyArn: 'arn:aws:kms:us-west-2:1:key/abc',
    });
  });

  it('maps bare managed to managed with undefined tuning (service defaults)', () => {
    expect(toMemoryAddOptions({ mode: 'managed' })).toEqual({
      memoryMode: 'managed',
      memoryStrategies: undefined,
      memoryEventExpiryDays: undefined,
      memoryEncryptionKeyArn: undefined,
    });
  });

  it('maps existing WITH retrieval tuning — tuning must NOT be dropped', () => {
    const memory: AddHarnessConfig['memory'] = {
      mode: 'existing',
      arn: 'arn:aws:bedrock-agentcore:us-west-2:1:memory/m-aBcD012345',
      actorId: 'actor-1',
      messagesCount: 20,
      topK: 5,
      relevanceScore: 0.7,
    };
    expect(toMemoryAddOptions(memory)).toEqual({
      memoryMode: 'existing',
      memoryName: undefined,
      memoryArn: 'arn:aws:bedrock-agentcore:us-west-2:1:memory/m-aBcD012345',
      memoryActorId: 'actor-1',
      messagesCount: 20,
      memoryTopK: 5,
      memoryRelevanceScore: 0.7,
    });
  });

  it('maps existing by name with no tuning', () => {
    expect(toMemoryAddOptions({ mode: 'existing', name: 'myMem' })).toEqual({
      memoryMode: 'existing',
      memoryName: 'myMem',
      memoryArn: undefined,
      memoryActorId: undefined,
      messagesCount: undefined,
      memoryTopK: undefined,
      memoryRelevanceScore: undefined,
    });
  });

  it('maps disabled to a bare disabled option', () => {
    expect(toMemoryAddOptions({ mode: 'disabled' })).toEqual({ memoryMode: 'disabled' });
  });

  it('falls through to disabled when memory is undefined (opt-in: silence means no memory)', () => {
    expect(toMemoryAddOptions(undefined)).toEqual({ memoryMode: 'disabled' });
  });
});
