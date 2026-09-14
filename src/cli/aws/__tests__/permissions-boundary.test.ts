import { CDK_PERMISSIONS_BOUNDARY_CONTEXT_KEY, PERMISSIONS_BOUNDARY_ENV_VAR } from '../../constants';
import {
  isPermissionsBoundaryArn,
  permissionsBoundaryCdkContext,
  resolvePermissionsBoundary,
  toPermissionsBoundaryArn,
} from '../permissions-boundary';
import { describe, expect, it } from 'vitest';

const BOUNDARY_NAME = 'AgentCoreExecutionRoleBoundary';
const BOUNDARY_ARN = `arn:aws:iam::111122223333:policy/${BOUNDARY_NAME}`;

describe('resolvePermissionsBoundary', () => {
  it('returns undefined when nothing is configured', () => {
    expect(resolvePermissionsBoundary({ env: {} })).toBeUndefined();
  });

  it('prefers the explicit override over the environment and config', () => {
    const resolved = resolvePermissionsBoundary({
      override: 'FromFlag',
      configured: 'FromConfig',
      env: { [PERMISSIONS_BOUNDARY_ENV_VAR]: 'FromEnv' },
    });

    expect(resolved).toBe('FromFlag');
  });

  it('prefers the environment over the project config', () => {
    const resolved = resolvePermissionsBoundary({
      configured: 'FromConfig',
      env: { [PERMISSIONS_BOUNDARY_ENV_VAR]: 'FromEnv' },
    });

    expect(resolved).toBe('FromEnv');
  });

  it('falls back to the project config', () => {
    expect(resolvePermissionsBoundary({ configured: BOUNDARY_NAME, env: {} })).toBe(BOUNDARY_NAME);
  });

  it('prefers the project config over the machine global config', () => {
    expect(resolvePermissionsBoundary({ configured: 'FromProject', global: 'FromGlobal', env: {} })).toBe(
      'FromProject'
    );
  });

  it('falls back to the machine global config', () => {
    expect(resolvePermissionsBoundary({ global: BOUNDARY_NAME, env: {} })).toBe(BOUNDARY_NAME);
  });

  it('trims values and skips blank ones', () => {
    const resolved = resolvePermissionsBoundary({
      configured: `  ${BOUNDARY_NAME}  `,
      env: { [PERMISSIONS_BOUNDARY_ENV_VAR]: '   ' },
    });

    expect(resolved).toBe(BOUNDARY_NAME);
  });

  // `agentcore config` can only write keys, so `agentcore config permissionsBoundary ''` is the
  // only way to clear the machine default. A blank must therefore read as unset, not as a
  // fall-through to the next source.
  it('treats a blank value as unset at every source', () => {
    expect(resolvePermissionsBoundary({ global: '', env: {} })).toBeUndefined();
    expect(resolvePermissionsBoundary({ global: '   ', env: {} })).toBeUndefined();
    expect(resolvePermissionsBoundary({ configured: '', env: {} })).toBeUndefined();
    expect(resolvePermissionsBoundary({ override: '', env: {} })).toBeUndefined();
    expect(resolvePermissionsBoundary({ env: { [PERMISSIONS_BOUNDARY_ENV_VAR]: '' } })).toBeUndefined();
  });

  it('does not let a blank higher-precedence source mask a lower one', () => {
    expect(resolvePermissionsBoundary({ override: '', configured: BOUNDARY_NAME, env: {} })).toBe(BOUNDARY_NAME);
    expect(resolvePermissionsBoundary({ configured: '  ', global: BOUNDARY_NAME, env: {} })).toBe(BOUNDARY_NAME);
  });

  it('resolves the full precedence chain in order', () => {
    const all = {
      override: 'FromOverride',
      configured: 'FromProject',
      global: 'FromGlobal',
      env: { [PERMISSIONS_BOUNDARY_ENV_VAR]: 'FromEnv' },
    };

    expect(resolvePermissionsBoundary(all)).toBe('FromOverride');
    expect(resolvePermissionsBoundary({ ...all, override: undefined })).toBe('FromEnv');
    expect(resolvePermissionsBoundary({ ...all, override: undefined, env: {} })).toBe('FromProject');
    expect(resolvePermissionsBoundary({ ...all, override: undefined, env: {}, configured: undefined })).toBe(
      'FromGlobal'
    );
  });
});

describe('isPermissionsBoundaryArn', () => {
  it('recognises ARNs across partitions', () => {
    expect(isPermissionsBoundaryArn(BOUNDARY_ARN)).toBe(true);
    expect(isPermissionsBoundaryArn('arn:aws-cn:iam::111122223333:policy/Boundary')).toBe(true);
    expect(isPermissionsBoundaryArn('arn:aws-us-gov:iam::111122223333:policy/Boundary')).toBe(true);
  });

  it('treats bare policy names as names', () => {
    expect(isPermissionsBoundaryArn(BOUNDARY_NAME)).toBe(false);
    expect(isPermissionsBoundaryArn('arnold-boundary')).toBe(false);
  });
});

describe('permissionsBoundaryCdkContext', () => {
  it('maps a policy name to the CDK name form', () => {
    expect(permissionsBoundaryCdkContext(BOUNDARY_NAME)).toEqual({
      [CDK_PERMISSIONS_BOUNDARY_CONTEXT_KEY]: { name: BOUNDARY_NAME },
    });
  });

  it('maps a policy ARN to the CDK arn form', () => {
    expect(permissionsBoundaryCdkContext(BOUNDARY_ARN)).toEqual({
      [CDK_PERMISSIONS_BOUNDARY_CONTEXT_KEY]: { arn: BOUNDARY_ARN },
    });
  });
});

describe('toPermissionsBoundaryArn', () => {
  it('expands a policy name using the target partition and account', () => {
    expect(toPermissionsBoundaryArn(BOUNDARY_NAME, { region: 'us-east-1', accountId: '111122223333' })).toBe(
      BOUNDARY_ARN
    );
  });

  it('uses the China partition for cn regions', () => {
    expect(toPermissionsBoundaryArn(BOUNDARY_NAME, { region: 'cn-north-1', accountId: '111122223333' })).toBe(
      `arn:aws-cn:iam::111122223333:policy/${BOUNDARY_NAME}`
    );
  });

  it('uses the GovCloud partition for us-gov regions', () => {
    expect(toPermissionsBoundaryArn(BOUNDARY_NAME, { region: 'us-gov-west-1', accountId: '111122223333' })).toBe(
      `arn:aws-us-gov:iam::111122223333:policy/${BOUNDARY_NAME}`
    );
  });

  it('passes an ARN through unchanged', () => {
    expect(toPermissionsBoundaryArn(BOUNDARY_ARN, { region: 'us-east-1', accountId: '999988887777' })).toBe(
      BOUNDARY_ARN
    );
  });
});
