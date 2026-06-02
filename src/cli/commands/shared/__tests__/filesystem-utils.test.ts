import {
  validateAccessPointMounts,
  validateBYOMountPath,
  validateEfsAccessPointArn,
  validateS3FilesAccessPointArn,
  zipAccessPointPairs,
} from '../filesystem-utils';
import { describe, expect, it } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// validateEfsAccessPointArn
// ─────────────────────────────────────────────────────────────────────────────

describe('validateEfsAccessPointArn', () => {
  it.each([
    'arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-0123456789abcdef0',
    'arn:aws-cn:elasticfilesystem:cn-north-1:123456789012:access-point/fsap-abcdef12',
    'arn:aws-us-gov:elasticfilesystem:us-gov-west-1:000000000000:access-point/fsap-0000000000000000000000000000000000000000',
  ])('accepts valid EFS ARN: %s', arn => {
    expect(validateEfsAccessPointArn(arn)).toBe(true);
  });

  it('rejects ARN with missing account ID', () => {
    const result = validateEfsAccessPointArn('arn:aws:elasticfilesystem:us-east-1:access-point/fsap-0123456789abcdef0');
    expect(result).not.toBe(true);
    expect(result).toContain('Invalid EFS access point ARN');
  });

  it('rejects ARN with non-numeric account ID', () => {
    const result = validateEfsAccessPointArn(
      'arn:aws:elasticfilesystem:us-east-1:badaccount:access-point/fsap-0123456789abcdef0'
    );
    expect(result).not.toBe(true);
  });

  it('rejects ARN with wrong service', () => {
    const result = validateEfsAccessPointArn('arn:aws:s3:us-east-1:123456789012:access-point/fsap-0123456789abcdef0');
    expect(result).not.toBe(true);
  });

  it('rejects ARN with access point ID too short (< 8 hex chars)', () => {
    const result = validateEfsAccessPointArn(
      'arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-0123456'
    );
    expect(result).not.toBe(true);
  });

  it('rejects ARN with uppercase hex in access point ID', () => {
    const result = validateEfsAccessPointArn(
      'arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-ABCDEF1234567890'
    );
    expect(result).not.toBe(true);
  });

  it('rejects empty string', () => {
    expect(validateEfsAccessPointArn('')).not.toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateS3FilesAccessPointArn
// ─────────────────────────────────────────────────────────────────────────────

describe('validateS3FilesAccessPointArn', () => {
  const validArn =
    'arn:aws:s3files:us-east-1:123456789012:file-system/fs-12345678901234567/access-point/fsap-12345678901234567';

  it('accepts a valid S3 Files ARN', () => {
    expect(validateS3FilesAccessPointArn(validArn)).toBe(true);
  });

  it('accepts GovCloud partition', () => {
    const arn =
      'arn:aws-us-gov:s3files:us-gov-west-1:123456789012:file-system/fs-12345678901234567/access-point/fsap-12345678901234567';
    expect(validateS3FilesAccessPointArn(arn)).toBe(true);
  });

  it('rejects ARN with missing account ID', () => {
    const arn = 'arn:aws:s3files:us-east-1:file-system/fs-12345678901234567/access-point/fsap-12345678901234567';
    expect(validateS3FilesAccessPointArn(arn)).not.toBe(true);
  });

  it('rejects ARN with wrong service', () => {
    const arn =
      'arn:aws:s3:us-east-1:123456789012:file-system/fs-12345678901234567/access-point/fsap-12345678901234567';
    expect(validateS3FilesAccessPointArn(arn)).not.toBe(true);
  });

  it('rejects ARN where fs ID is too short (< 17 hex chars)', () => {
    const arn =
      'arn:aws:s3files:us-east-1:123456789012:file-system/fs-1234567890123456/access-point/fsap-12345678901234567';
    expect(validateS3FilesAccessPointArn(arn)).not.toBe(true);
  });

  it('rejects ARN where access point ID is too short (< 17 hex chars)', () => {
    const arn =
      'arn:aws:s3files:us-east-1:123456789012:file-system/fs-12345678901234567/access-point/fsap-1234567890123456';
    expect(validateS3FilesAccessPointArn(arn)).not.toBe(true);
  });

  it('rejects empty string', () => {
    expect(validateS3FilesAccessPointArn('')).not.toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateBYOMountPath
// ─────────────────────────────────────────────────────────────────────────────

describe('validateBYOMountPath', () => {
  it.each(['/mnt/data', '/mnt/tools', '/mnt/my-data', '/mnt/data_v2', '/mnt/data.bak', '/mnt/data/'])(
    'accepts valid mount path: %s',
    path => {
      expect(validateBYOMountPath(path)).toBe(true);
    }
  );

  it('rejects path not under /mnt/', () => {
    expect(validateBYOMountPath('/data/tools')).not.toBe(true);
  });

  it('rejects path with two subdirectory levels', () => {
    expect(validateBYOMountPath('/mnt/foo/bar')).not.toBe(true);
  });

  it('rejects /mnt/ with no subdirectory', () => {
    expect(validateBYOMountPath('/mnt/')).not.toBe(true);
  });

  it('rejects path shorter than 6 characters', () => {
    expect(validateBYOMountPath('/mnt/')).not.toBe(true);
  });

  it('rejects path longer than 200 characters', () => {
    const long = '/mnt/' + 'a'.repeat(196);
    expect(validateBYOMountPath(long)).not.toBe(true);
  });

  it('rejects empty string', () => {
    expect(validateBYOMountPath('')).not.toBe(true);
  });

  it('rejects path with special characters in name', () => {
    expect(validateBYOMountPath('/mnt/foo bar')).not.toBe(true);
    expect(validateBYOMountPath('/mnt/foo@bar')).not.toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// zipAccessPointPairs
// ─────────────────────────────────────────────────────────────────────────────

describe('zipAccessPointPairs', () => {
  it('pairs matching ARN and path arrays', () => {
    const result = zipAccessPointPairs(
      ['arn:aws:efs:us-east-1:123:access-point/fsap-aaa', 'arn:aws:efs:us-east-1:123:access-point/fsap-bbb'],
      ['/mnt/a', '/mnt/b'],
      'EFS'
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.mounts).toEqual([
        { accessPointArn: 'arn:aws:efs:us-east-1:123:access-point/fsap-aaa', mountPath: '/mnt/a' },
        { accessPointArn: 'arn:aws:efs:us-east-1:123:access-point/fsap-bbb', mountPath: '/mnt/b' },
      ]);
    }
  });

  it('returns success with empty arrays', () => {
    const result = zipAccessPointPairs([], [], 'EFS');
    expect(result.success).toBe(true);
    if (result.success) expect(result.mounts).toEqual([]);
  });

  it('returns error when ARN count exceeds path count (EFS)', () => {
    const result = zipAccessPointPairs(['arn1', 'arn2'], ['/mnt/a'], 'EFS');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('--efs-access-point-arn');
      expect(result.error).toContain('--efs-mount-path');
      expect(result.error).toContain('2 ARN(s)');
      expect(result.error).toContain('1 path(s)');
    }
  });

  it('returns error when path count exceeds ARN count (S3 Files)', () => {
    const result = zipAccessPointPairs(['arn1'], ['/mnt/a', '/mnt/b'], 'S3 Files');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('--s3-access-point-arn');
      expect(result.error).toContain('--s3-mount-path');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateAccessPointMounts
// ─────────────────────────────────────────────────────────────────────────────

describe('validateAccessPointMounts', () => {
  const validEfsArn = 'arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-0123456789abcdef0';
  const validPath = '/mnt/tools';

  it('returns success for empty mounts array', () => {
    expect(validateAccessPointMounts([], validateEfsAccessPointArn)).toEqual({ success: true });
  });

  it('returns success for valid EFS mount', () => {
    const result = validateAccessPointMounts(
      [{ accessPointArn: validEfsArn, mountPath: validPath }],
      validateEfsAccessPointArn
    );
    expect(result).toEqual({ success: true });
  });

  it('returns error on first invalid ARN', () => {
    const result = validateAccessPointMounts(
      [
        { accessPointArn: validEfsArn, mountPath: validPath },
        { accessPointArn: 'bad-arn', mountPath: '/mnt/other' },
      ],
      validateEfsAccessPointArn
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('Invalid EFS access point ARN');
  });

  it('returns error on invalid mount path even with valid ARN', () => {
    const result = validateAccessPointMounts(
      [{ accessPointArn: validEfsArn, mountPath: '/not/under/mnt' }],
      validateEfsAccessPointArn
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('Invalid mount path');
  });

  it('validates multiple mounts and stops at first failure', () => {
    const results: boolean[] = [];
    validateAccessPointMounts(
      [
        { accessPointArn: validEfsArn, mountPath: validPath },
        { accessPointArn: 'bad', mountPath: validPath },
        { accessPointArn: 'also-bad', mountPath: validPath },
      ],
      arn => {
        results.push(arn === validEfsArn);
        return arn === validEfsArn ? true : `bad: ${arn}`;
      }
    );
    expect(results).toHaveLength(2);
  });

  it('uses provided arnValidator (S3 Files)', () => {
    const validS3Arn =
      'arn:aws:s3files:us-east-1:123456789012:file-system/fs-12345678901234567/access-point/fsap-12345678901234567';
    const result = validateAccessPointMounts(
      [{ accessPointArn: validS3Arn, mountPath: '/mnt/datasets' }],
      validateS3FilesAccessPointArn
    );
    expect(result).toEqual({ success: true });
  });
});
