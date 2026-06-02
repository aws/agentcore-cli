import { validateCreateHarnessOptions } from '../harness-validate.js';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const VALID_EFS_ARN = 'arn:aws:elasticfilesystem:us-east-1:053460373529:access-point/fsap-084270434ad6d5dcb';
const VALID_S3_ARN =
  'arn:aws:s3files:us-east-1:053460373529:file-system/fs-04191956416f17799/access-point/fsap-01bff5a982cb35c1d';

function makeCwd() {
  const dir = join(tmpdir(), `harness-validate-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const baseOptions = {
  name: 'MyHarness',
  modelProvider: 'bedrock',
};

const vpcOptions = {
  networkMode: 'VPC',
  subnets: 'subnet-0bd65c3a6eaa74d99',
  securityGroups: 'sg-07234e16e36d51629',
};

// ─────────────────────────────────────────────────────────────────────────────
// EFS access point validation
// ─────────────────────────────────────────────────────────────────────────────

describe('validateCreateHarnessOptions - EFS access points', () => {
  it('accepts valid EFS ARN + path pair with VPC', () => {
    const result = validateCreateHarnessOptions(
      { ...baseOptions, ...vpcOptions, efsAccessPointArn: [VALID_EFS_ARN], efsMountPath: ['/mnt/efs'] },
      makeCwd()
    );
    expect(result.valid).toBe(true);
  });

  it('accepts two EFS mounts (at max)', () => {
    const result = validateCreateHarnessOptions(
      {
        ...baseOptions,
        ...vpcOptions,
        efsAccessPointArn: [VALID_EFS_ARN, VALID_EFS_ARN],
        efsMountPath: ['/mnt/efs1', '/mnt/efs2'],
      },
      makeCwd()
    );
    expect(result.valid).toBe(true);
  });

  it('rejects three EFS mounts (exceeds max)', () => {
    const result = validateCreateHarnessOptions(
      {
        ...baseOptions,
        ...vpcOptions,
        efsAccessPointArn: [VALID_EFS_ARN, VALID_EFS_ARN, VALID_EFS_ARN],
        efsMountPath: ['/mnt/efs1', '/mnt/efs2', '/mnt/efs3'],
      },
      makeCwd()
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Maximum 2 EFS mounts');
  });

  it('rejects mismatched ARN/path counts', () => {
    const result = validateCreateHarnessOptions(
      {
        ...baseOptions,
        ...vpcOptions,
        efsAccessPointArn: [VALID_EFS_ARN, VALID_EFS_ARN],
        efsMountPath: ['/mnt/efs'],
      },
      makeCwd()
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain('matching pairs');
  });

  it('rejects invalid EFS ARN format', () => {
    const result = validateCreateHarnessOptions(
      { ...baseOptions, ...vpcOptions, efsAccessPointArn: ['not-an-arn'], efsMountPath: ['/mnt/efs'] },
      makeCwd()
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid EFS access point ARN');
  });

  it('rejects EFS without VPC network mode', () => {
    const result = validateCreateHarnessOptions(
      { ...baseOptions, efsAccessPointArn: [VALID_EFS_ARN], efsMountPath: ['/mnt/efs'] },
      makeCwd()
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain('VPC network mode');
  });

  it('rejects path-only with no ARN', () => {
    const result = validateCreateHarnessOptions(
      { ...baseOptions, ...vpcOptions, efsMountPath: ['/mnt/efs'] },
      makeCwd()
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain('matching pairs');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S3 Files access point validation
// ─────────────────────────────────────────────────────────────────────────────

describe('validateCreateHarnessOptions - S3 Files access points', () => {
  it('accepts valid S3 ARN + path pair with VPC', () => {
    const result = validateCreateHarnessOptions(
      { ...baseOptions, ...vpcOptions, s3AccessPointArn: [VALID_S3_ARN], s3MountPath: ['/mnt/s3'] },
      makeCwd()
    );
    expect(result.valid).toBe(true);
  });

  it('rejects three S3 mounts (exceeds max)', () => {
    const result = validateCreateHarnessOptions(
      {
        ...baseOptions,
        ...vpcOptions,
        s3AccessPointArn: [VALID_S3_ARN, VALID_S3_ARN, VALID_S3_ARN],
        s3MountPath: ['/mnt/s31', '/mnt/s32', '/mnt/s33'],
      },
      makeCwd()
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Maximum 2 S3 Files mounts');
  });

  it('rejects invalid S3 ARN format', () => {
    const result = validateCreateHarnessOptions(
      { ...baseOptions, ...vpcOptions, s3AccessPointArn: ['not-an-arn'], s3MountPath: ['/mnt/s3'] },
      makeCwd()
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid S3 Files access point ARN');
  });

  it('rejects S3 without VPC network mode', () => {
    const result = validateCreateHarnessOptions(
      { ...baseOptions, s3AccessPointArn: [VALID_S3_ARN], s3MountPath: ['/mnt/s3'] },
      makeCwd()
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain('VPC network mode');
  });

  it('accepts EFS + S3 together with VPC', () => {
    const result = validateCreateHarnessOptions(
      {
        ...baseOptions,
        ...vpcOptions,
        efsAccessPointArn: [VALID_EFS_ARN],
        efsMountPath: ['/mnt/efs'],
        s3AccessPointArn: [VALID_S3_ARN],
        s3MountPath: ['/mnt/s3'],
      },
      makeCwd()
    );
    expect(result.valid).toBe(true);
  });

  it('rejects S3 mismatched pairs', () => {
    const result = validateCreateHarnessOptions(
      { ...baseOptions, ...vpcOptions, s3AccessPointArn: [VALID_S3_ARN], s3MountPath: [] },
      makeCwd()
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain('matching pairs');
  });
});
