import {
  AgentCoreRegionSchema,
  AwsAccountIdSchema,
  AwsDeploymentTargetSchema,
  AwsDeploymentTargetsSchema,
  DeploymentTargetNameSchema,
} from '../aws-targets.js';
import { describe, expect, it } from 'vitest';

describe('AgentCoreRegionSchema', () => {
  const validRegions = [
    'ap-northeast-1',
    'ap-south-1',
    'ap-southeast-1',
    'ap-southeast-2',
    'eu-central-1',
    'eu-west-1',
    'us-east-1',
    'us-east-2',
    'us-west-2',
  ];

  it.each(validRegions)('accepts valid region "%s"', region => {
    expect(AgentCoreRegionSchema.safeParse(region).success).toBe(true);
  });

  it('rejects unsupported regions', () => {
    expect(AgentCoreRegionSchema.safeParse('us-west-1').success).toBe(false);
    expect(AgentCoreRegionSchema.safeParse('eu-west-2').success).toBe(false);
    expect(AgentCoreRegionSchema.safeParse('sa-east-1').success).toBe(false);
  });

  it('rejects empty string', () => {
    expect(AgentCoreRegionSchema.safeParse('').success).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(AgentCoreRegionSchema.safeParse(123).success).toBe(false);
    expect(AgentCoreRegionSchema.safeParse(null).success).toBe(false);
  });
});

describe('AwsAccountIdSchema', () => {
  it('accepts valid 12-digit account ID', () => {
    expect(AwsAccountIdSchema.safeParse('123456789012').success).toBe(true);
    expect(AwsAccountIdSchema.safeParse('000000000000').success).toBe(true);
  });

  it('rejects account ID shorter than 12 digits', () => {
    expect(AwsAccountIdSchema.safeParse('12345678901').success).toBe(false);
  });

  it('rejects account ID longer than 12 digits', () => {
    expect(AwsAccountIdSchema.safeParse('1234567890123').success).toBe(false);
  });

  it('rejects non-numeric account ID', () => {
    expect(AwsAccountIdSchema.safeParse('12345678901a').success).toBe(false);
    expect(AwsAccountIdSchema.safeParse('abcdefghijkl').success).toBe(false);
  });

  it('rejects account ID with spaces', () => {
    expect(AwsAccountIdSchema.safeParse('123 456 7890').success).toBe(false);
  });

  it('rejects empty string', () => {
    expect(AwsAccountIdSchema.safeParse('').success).toBe(false);
  });
});

describe('DeploymentTargetNameSchema', () => {
  it('accepts valid names', () => {
    expect(DeploymentTargetNameSchema.safeParse('default').success).toBe(true);
    expect(DeploymentTargetNameSchema.safeParse('prod').success).toBe(true);
    expect(DeploymentTargetNameSchema.safeParse('dev-us-east').success).toBe(true);
    expect(DeploymentTargetNameSchema.safeParse('staging_env').success).toBe(true);
  });

  it('rejects name starting with digit', () => {
    expect(DeploymentTargetNameSchema.safeParse('1target').success).toBe(false);
  });

  it('rejects name starting with hyphen', () => {
    expect(DeploymentTargetNameSchema.safeParse('-target').success).toBe(false);
  });

  it('rejects empty string', () => {
    expect(DeploymentTargetNameSchema.safeParse('').success).toBe(false);
  });

  it('rejects name exceeding 64 chars', () => {
    const name = 'a'.repeat(65);
    expect(DeploymentTargetNameSchema.safeParse(name).success).toBe(false);
  });

  it('accepts 64-char name (max)', () => {
    const name = 'a'.repeat(64);
    expect(DeploymentTargetNameSchema.safeParse(name).success).toBe(true);
  });
});

describe('AwsDeploymentTargetSchema', () => {
  const validTarget = {
    name: 'prod',
    account: '123456789012',
    region: 'us-east-1',
  };

  it('accepts valid target', () => {
    expect(AwsDeploymentTargetSchema.safeParse(validTarget).success).toBe(true);
  });

  it('accepts target with optional description', () => {
    const result = AwsDeploymentTargetSchema.safeParse({
      ...validTarget,
      description: 'Production environment',
    });
    expect(result.success).toBe(true);
  });

  it('rejects description exceeding 256 chars', () => {
    const result = AwsDeploymentTargetSchema.safeParse({
      ...validTarget,
      description: 'a'.repeat(257),
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing required fields', () => {
    expect(AwsDeploymentTargetSchema.safeParse({ name: 'prod' }).success).toBe(false);
    expect(AwsDeploymentTargetSchema.safeParse({ account: '123456789012' }).success).toBe(false);
  });
});

describe('AwsDeploymentTargetsSchema', () => {
  it('accepts array of unique targets', () => {
    const result = AwsDeploymentTargetsSchema.safeParse([
      { name: 'dev', account: '123456789012', region: 'us-east-1' },
      { name: 'prod', account: '987654321098', region: 'us-west-2' },
    ]);
    expect(result.success).toBe(true);
  });

  it('accepts empty array', () => {
    expect(AwsDeploymentTargetsSchema.safeParse([]).success).toBe(true);
  });

  it('rejects duplicate target names', () => {
    const result = AwsDeploymentTargetsSchema.safeParse([
      { name: 'prod', account: '123456789012', region: 'us-east-1' },
      { name: 'prod', account: '987654321098', region: 'us-west-2' },
    ]);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('Duplicate deployment target name'))).toBe(true);
    }
  });
});
