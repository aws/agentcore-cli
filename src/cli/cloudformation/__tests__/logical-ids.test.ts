import { toPascalId } from '../logical-ids.js';
import { describe, expect, it } from 'vitest';

describe('toPascalId', () => {
  it('converts simple name to PascalCase', () => {
    expect(toPascalId('myAgent')).toBe('MyAgent');
  });

  it('converts hyphenated name', () => {
    expect(toPascalId('my-gateway')).toBe('MyGateway');
  });

  it('converts underscored name', () => {
    expect(toPascalId('my_tool')).toBe('MyTool');
  });

  it('joins multiple parts', () => {
    expect(toPascalId('agent', 'runtime')).toBe('AgentRuntime');
  });

  it('handles already PascalCase input', () => {
    expect(toPascalId('MyAgent')).toBe('MyAgent');
  });

  it('handles mixed casing with delimiters', () => {
    expect(toPascalId('my-cool_agent')).toBe('MyCoolAgent');
  });

  it('joins multiple parts with delimiters', () => {
    expect(toPascalId('my-gateway', 'lambda-func')).toBe('MyGatewayLambdaFunc');
  });

  it('throws for no parts', () => {
    expect(() => toPascalId()).toThrow('at least one part');
  });

  it('throws for result with invalid characters', () => {
    // A name that after conversion contains invalid CloudFormation logical ID chars
    expect(() => toPascalId('123invalid')).toThrow('Invalid CloudFormation logical ID');
  });

  it('throws for empty string part', () => {
    // Empty string produces empty logical ID
    expect(() => toPascalId('')).toThrow();
  });
});
