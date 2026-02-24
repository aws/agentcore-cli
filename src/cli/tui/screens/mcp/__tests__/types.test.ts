import { AUTHORIZER_TYPE_OPTIONS, SKIP_FOR_NOW, SOURCE_OPTIONS } from '../types.js';
import { describe, expect, it } from 'vitest';

describe('MCP types constants', () => {
  it('AUTHORIZER_TYPE_OPTIONS: AWS_IAM is first option', () => {
    expect(AUTHORIZER_TYPE_OPTIONS[0]?.id).toBe('AWS_IAM');
  });

  it('SKIP_FOR_NOW equals skip-for-now', () => {
    expect(SKIP_FOR_NOW).toBe('skip-for-now');
  });

  it('SOURCE_OPTIONS has entries for existing-endpoint and create-new', () => {
    const existingEndpoint = SOURCE_OPTIONS.find((opt: { id: string }) => opt.id === 'existing-endpoint');
    const createNew = SOURCE_OPTIONS.find((opt: { id: string }) => opt.id === 'create-new');

    expect(existingEndpoint).toBeDefined();
    expect(createNew).toBeDefined();
  });
});
