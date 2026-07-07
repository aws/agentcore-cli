import { synthesizeCedar } from '../synthesize-cedar.js';
import type { GuardrailFormConfig } from '../types.js';
import { describe, expect, it } from 'vitest';

describe('synthesizeCedar', () => {
  const baseForm: GuardrailFormConfig = {
    category: 'contentFilter',
    filters: ['VIOLENCE'],
    effect: 'forbid',
    dataPath: 'context.input.prompt',
  };

  it('returns comment when no category is set', () => {
    const form: GuardrailFormConfig = { category: null, filters: [], effect: 'forbid', dataPath: '' };
    expect(synthesizeCedar(form)).toBe('// No guardrail rules configured');
  });

  it('returns comment when filters are empty', () => {
    const form: GuardrailFormConfig = { category: 'contentFilter', filters: [], effect: 'forbid', dataPath: '' };
    expect(synthesizeCedar(form)).toBe('// No guardrail rules configured');
  });

  it('generates forbid policy with single content filter', () => {
    const result = synthesizeCedar(baseForm);
    expect(result).toContain('forbid (principal, action, resource is AgentCore::Gateway)');
    expect(result).toContain('BedrockGuardrails::ContentFilter');
    expect(result).toContain('["VIOLENCE"]');
    expect(result).toContain('["VIOLENCE"].confidenceScore');
    expect(result).toContain('.greaterThan(decimal("0.2"))');
    expect(result).toContain('[context.input.prompt]');
  });

  it('generates a policy with the INSULTS content filter (canonical plural name)', () => {
    const form: GuardrailFormConfig = { ...baseForm, filters: ['INSULTS'] };
    const result = synthesizeCedar(form);
    expect(result).toContain('["INSULTS"]');
  });

  it('generates permit policy with single filter using lessThanOrEqual', () => {
    const form: GuardrailFormConfig = { ...baseForm, effect: 'permit' };
    const result = synthesizeCedar(form);
    expect(result).toContain('permit (principal, action, resource is AgentCore::Gateway)');
    expect(result).toContain('.lessThanOrEqual(decimal("0.2"))');
  });

  it('uses maxConfidenceScore for multiple filters', () => {
    const form: GuardrailFormConfig = { ...baseForm, filters: ['VIOLENCE', 'HATE'] };
    const result = synthesizeCedar(form);
    expect(result).toContain('["VIOLENCE", "HATE"]');
    expect(result).toContain('.maxConfidenceScore().greaterThan(decimal("0.2"))');
    expect(result).not.toContain('confidenceScore');
  });

  it('uses promptAttack function and threshold', () => {
    const form: GuardrailFormConfig = {
      category: 'promptAttack',
      filters: ['JAILBREAK'],
      effect: 'forbid',
      dataPath: 'context.input.prompt',
    };
    const result = synthesizeCedar(form);
    expect(result).toContain('BedrockGuardrails::PromptAttack');
    expect(result).toContain('.greaterThan(decimal("0.4"))');
  });

  it('uses sensitiveInformation function and threshold', () => {
    const form: GuardrailFormConfig = {
      category: 'sensitiveInformation',
      filters: ['EMAIL', 'PHONE'],
      effect: 'forbid',
      dataPath: 'context.input.prompt',
    };
    const result = synthesizeCedar(form);
    expect(result).toContain('BedrockGuardrails::SensitiveInformation');
    expect(result).toContain('["EMAIL", "PHONE"]');
    expect(result).toContain('.maxConfidenceScore().greaterThan(decimal("0.2"))');
  });

  it('includes targetName in action reference when provided', () => {
    const result = synthesizeCedar(baseForm, { targetName: 'my-target' });
    expect(result).toContain('action == AgentCore::Action::"my-target___POST:/invocations"');
  });

  it('includes gatewayArn in resource reference when provided', () => {
    const result = synthesizeCedar(baseForm, { gatewayArn: 'arn:aws:agentcore:us-east-1:123456:gateway/gw-123' });
    expect(result).toContain('resource == AgentCore::Gateway::"arn:aws:agentcore:us-east-1:123456:gateway/gw-123"');
  });

  it('includes both targetName and gatewayArn when provided', () => {
    const result = synthesizeCedar(baseForm, {
      targetName: 'prod',
      gatewayArn: 'arn:aws:agentcore:us-east-1:123456:gateway/gw-abc',
    });
    expect(result).toContain('action == AgentCore::Action::"prod___POST:/invocations"');
    expect(result).toContain('resource == AgentCore::Gateway::"arn:aws:agentcore:us-east-1:123456:gateway/gw-abc"');
  });

  it('uses custom dataPath', () => {
    const form: GuardrailFormConfig = { ...baseForm, dataPath: 'context.output.response' };
    const result = synthesizeCedar(form);
    expect(result).toContain('[context.output.response]');
  });

  it('generates suppressOutput policy using greaterThan and an output data path by default', () => {
    const form: GuardrailFormConfig = { ...baseForm, effect: 'suppressOutput', dataPath: '' };
    const result = synthesizeCedar(form);
    expect(result).toContain('suppressOutput (principal, action, resource is AgentCore::Gateway)');
    expect(result).toContain('.greaterThan(decimal("0.2"))');
    // suppressOutput evaluates the model response, so it defaults to context.output.*
    expect(result).toContain('[context.output.prompt]');
    expect(result).not.toContain('[context.input.prompt]');
  });

  it('respects an explicit dataPath for suppressOutput', () => {
    const form: GuardrailFormConfig = {
      ...baseForm,
      effect: 'suppressOutput',
      dataPath: 'context.output.response',
    };
    const result = synthesizeCedar(form);
    expect(result).toContain('[context.output.response]');
  });

  it('uses maxConfidenceScore + greaterThan for multi-filter suppressOutput', () => {
    const form: GuardrailFormConfig = {
      ...baseForm,
      effect: 'suppressOutput',
      filters: ['VIOLENCE', 'HATE'],
      dataPath: '',
    };
    const result = synthesizeCedar(form);
    expect(result).toContain('.maxConfidenceScore().greaterThan(decimal("0.2"))');
  });
});
