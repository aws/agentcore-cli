import { TagsSchema } from '../../../../schema/schemas/primitives/tags';
import { stripReservedTags } from '../import-utils';
import { describe, expect, it } from 'vitest';

// Regression: a runtime retained after its CloudFormation stack was deleted keeps orphaned
// aws:cloudformation:* tags. The import commands used to copy them verbatim into agentcore.json,
// where TagsSchema rejects the reserved "aws:" prefix and blocks the import.
describe('stripReservedTags', () => {
  const orphaned = {
    'aws:cloudformation:stack-name': 'AgentCore-MyProject-default',
    'aws:cloudformation:logical-id': 'ApplicationAgentMyAgentRuntime140BFE6B',
    'aws:cloudformation:stack-id':
      'arn:aws:cloudformation:us-east-1:123456789012:stack/AgentCore-MyProject-default/abc',
  };

  it('drops every aws: reserved key, leaving no tags to persist', () => {
    expect(stripReservedTags(orphaned)).toBeUndefined();
  });

  it('keeps user tags and removes only reserved ones', () => {
    const kept = stripReservedTags({ ...orphaned, team: 'life-sciences', env: 'test' });
    expect(kept).toEqual({ team: 'life-sciences', env: 'test' });
  });

  it('passes undefined through', () => {
    expect(stripReservedTags(undefined)).toBeUndefined();
  });

  it('produces tags that survive the config schema (the actual blocker)', () => {
    // Before the fix, feeding orphaned tags straight to TagsSchema throws "aws:" reserved.
    expect(() => TagsSchema.parse(orphaned)).toThrow();
    const cleaned = stripReservedTags({ ...orphaned, team: 'life-sciences' });
    expect(() => TagsSchema.parse(cleaned)).not.toThrow();
  });
});
