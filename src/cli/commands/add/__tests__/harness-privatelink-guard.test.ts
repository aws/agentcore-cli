import type { AddHarnessCliOptions } from '../types';
import { validateAddHarnessOptions } from '../validate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const base: AddHarnessCliOptions = {
  name: 'h1',
  modelProvider: 'bedrock',
  modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
};

const DISCOVERY = 'https://idp.example.com/.well-known/openid-configuration';

describe('validateAddHarnessOptions — PrivateLink authorizer guard', () => {
  it('rejects --private-endpoint-* flags with AWS_IAM authorizer', () => {
    const result = validateAddHarnessOptions({
      ...base,
      authorizerType: 'AWS_IAM',
      privateEndpointVpcId: 'vpc-0123456789abcdef0',
      privateEndpointSubnets: 'subnet-0123456789abcdef0',
      privateEndpointIpType: 'IPV4',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('only valid with CUSTOM_JWT');
  });

  it('rejects a private-endpoint flag when no authorizer type is set', () => {
    const result = validateAddHarnessOptions({ ...base, privateEndpointLatticeArn: 'rcfg-0123456789abcdefg' });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('only valid with CUSTOM_JWT');
  });

  it('accepts a private-endpoint flag with CUSTOM_JWT authorizer', () => {
    const result = validateAddHarnessOptions({
      ...base,
      authorizerType: 'CUSTOM_JWT',
      discoveryUrl: DISCOVERY,
      allowedAudience: 'aud-1',
      privateEndpointLatticeArn: 'rcfg-0123456789abcdefg',
    });
    expect(result.valid).toBe(true);
  });

  it('does not flag a plain AWS_IAM harness (no PrivateLink flags)', () => {
    const result = validateAddHarnessOptions({ ...base, authorizerType: 'AWS_IAM' });
    expect(result.valid).toBe(true);
  });
});

describe('validateAddHarnessOptions — memory flag coupling', () => {
  it('rejects --memory-arn together with --memory-name (mutually exclusive)', () => {
    const result = validateAddHarnessOptions({
      ...base,
      memoryArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:memory/Mem-aBcDeFgHiJ',
      memoryName: 'mem',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('mutually exclusive');
  });

  it('rejects --no-memory combined with --memory-arn', () => {
    const result = validateAddHarnessOptions({
      ...base,
      memory: false,
      memoryArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:memory/Mem-aBcDeFgHiJ',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('--no-memory');
  });

  it('rejects --no-memory combined with a memory tuning flag', () => {
    const result = validateAddHarnessOptions({ ...base, memory: false, memoryTopK: 5 });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('--no-memory');
  });

  it('accepts --memory-name alone', () => {
    expect(validateAddHarnessOptions({ ...base, memoryName: 'mem' }).valid).toBe(true);
  });
});

describe('validateAddHarnessOptions — gateway oauth flag coupling', () => {
  it('rejects --gateway-grant-type without --gateway-outbound-auth oauth', () => {
    const result = validateAddHarnessOptions({
      ...base,
      tools: 'agentcore_gateway',
      gatewayArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:gateway/gw',
      gatewayOutboundAuth: 'awsIam',
      gatewayGrantType: 'CLIENT_CREDENTIALS',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('--gateway-outbound-auth oauth');
  });

  it('rejects --gateway-custom-parameters when outbound-auth is absent', () => {
    const result = validateAddHarnessOptions({
      ...base,
      tools: 'agentcore_gateway',
      gatewayArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:gateway/gw',
      gatewayCustomParameters: '{"audience":"x"}',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('--gateway-outbound-auth oauth');
  });
});

describe('validateAddHarnessOptions — memory modes (gated OFF)', () => {
  const prev = process.env.ENABLE_GATED_FEATURES;
  beforeEach(() => {
    delete process.env.ENABLE_GATED_FEATURES;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.ENABLE_GATED_FEATURES;
    else process.env.ENABLE_GATED_FEATURES = prev;
  });

  it('rejects --memory-mode as not-yet-available', () => {
    const r = validateAddHarnessOptions({ ...base, memoryMode: 'managed' });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error).toContain('not yet available');
  });

  it('rejects managed-only flags as not-yet-available', () => {
    const r = validateAddHarnessOptions({ ...base, memoryStrategies: 'SEMANTIC' });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error).toContain('not yet available');
  });

  it('still accepts the legacy --memory-name reference', () => {
    expect(validateAddHarnessOptions({ ...base, memoryName: 'mem' }).valid).toBe(true);
  });
});

describe('validateAddHarnessOptions — memory modes (gated ON)', () => {
  const prev = process.env.ENABLE_GATED_FEATURES;
  beforeEach(() => {
    process.env.ENABLE_GATED_FEATURES = '1';
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.ENABLE_GATED_FEATURES;
    else process.env.ENABLE_GATED_FEATURES = prev;
  });

  it('rejects --memory-mode existing with neither arn nor name', () => {
    const r = validateAddHarnessOptions({ ...base, memoryMode: 'existing' });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error).toContain('existing');
  });

  it('rejects managed-only flags on existing mode', () => {
    const r = validateAddHarnessOptions({
      ...base,
      memoryMode: 'existing',
      memoryArn: 'arn:aws:bedrock-agentcore:us-west-2:1:memory/m-aBcD012345',
      memoryEventExpiryDays: 30,
    });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error).toContain('--memory-event-expiry-days');
  });

  it('rejects an invalid managed strategy', () => {
    const r = validateAddHarnessOptions({ ...base, memoryMode: 'managed', memoryStrategies: 'SEMANTIC,BOGUS' });
    expect(r.valid).toBe(false);
  });

  it('rejects CUSTOM as a managed strategy', () => {
    const r = validateAddHarnessOptions({ ...base, memoryMode: 'managed', memoryStrategies: 'CUSTOM' });
    expect(r.valid).toBe(false);
  });

  it('rejects an invalid --memory-mode value', () => {
    const r = validateAddHarnessOptions({ ...base, memoryMode: 'bogus' });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error).toContain('Invalid --memory-mode');
  });

  it('rejects --no-memory combined with --memory-mode managed', () => {
    const r = validateAddHarnessOptions({ ...base, memory: false, memoryMode: 'managed' });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error).toContain('--no-memory');
  });

  it('accepts a clean managed config', () => {
    expect(
      validateAddHarnessOptions({ ...base, memoryMode: 'managed', memoryStrategies: 'SEMANTIC,SUMMARIZATION' }).valid
    ).toBe(true);
  });

  it('accepts managed as the implicit default (no memory flags)', () => {
    expect(validateAddHarnessOptions({ ...base }).valid).toBe(true);
  });
});
