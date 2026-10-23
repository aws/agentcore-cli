import { CONFIG_DIR, CONFIG_FILES } from '../../../lib/constants';
import { PermissionsBoundaryRequiredError } from '../../../lib/errors/types';
import { CDK_PERMISSIONS_BOUNDARY_CONTEXT_KEY, CDK_PROJECT_DIR, PERMISSIONS_BOUNDARY_ENV_VAR } from '../../constants';
import {
  isPermissionsBoundaryDenial,
  readPermissionsBoundary,
  readPermissionsBoundaryContext,
  rewriteIfPermissionsBoundaryRequired,
} from '../permissions-boundary';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The global config path is resolved at module load, so the read is mocked rather than
// redirected. Keeps the suite independent of whatever ~/.agentcore/config.json holds.
const { readGlobalConfigMock } = vi.hoisted(() => ({
  readGlobalConfigMock: vi.fn(),
}));

vi.mock('../../../lib/schemas/io/global-config', () => ({
  readGlobalConfig: readGlobalConfigMock,
}));

const BOUNDARY_NAME = 'AgentCoreExecutionRoleBoundary';

const tmpRoot = mkdtempSync(join(tmpdir(), 'agentcore-boundary-test-'));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// File-level, not per-describe: every resolver in here consults the environment and the machine
// config, so a developer with AGENTCORE_PERMISSIONS_BOUNDARY exported or a boundary in
// ~/.agentcore/config.json would otherwise fail these tests.
const savedEnv = process.env[PERMISSIONS_BOUNDARY_ENV_VAR];

beforeEach(() => {
  delete process.env[PERMISSIONS_BOUNDARY_ENV_VAR];
  readGlobalConfigMock.mockResolvedValue({ success: true, config: {} });
});

afterEach(() => {
  if (savedEnv === undefined) {
    delete process.env[PERMISSIONS_BOUNDARY_ENV_VAR];
  } else {
    process.env[PERMISSIONS_BOUNDARY_ENV_VAR] = savedEnv;
  }
});

/**
 * Lay out a minimal `<root>/agentcore/{agentcore.json,cdk}` project and return the CDK
 * project directory, which is what the CDK toolkit wrapper hands to the resolver.
 */
function writeProject(spec: Record<string, unknown>): string {
  const projectRoot = mkdtempSync(join(tmpRoot, 'project-'));
  const configDir = join(projectRoot, CONFIG_DIR);
  const cdkDir = join(configDir, CDK_PROJECT_DIR);
  mkdirSync(cdkDir, { recursive: true });
  writeFileSync(join(configDir, CONFIG_FILES.AGENT_ENV), JSON.stringify(spec));
  return cdkDir;
}

function baseSpec(iam?: Record<string, unknown>): Record<string, unknown> {
  return {
    name: 'testproject',
    version: 1,
    managedBy: 'CDK',
    runtimes: [],
    ...(iam && { iam }),
  };
}

describe('readPermissionsBoundary', () => {
  it('reads iam.permissionsBoundary from agentcore.json', async () => {
    const cdkDir = writeProject(baseSpec({ permissionsBoundary: BOUNDARY_NAME }));

    await expect(readPermissionsBoundary(cdkDir)).resolves.toBe(BOUNDARY_NAME);
  });

  it('returns undefined when the project declares no boundary', async () => {
    const cdkDir = writeProject(baseSpec());

    await expect(readPermissionsBoundary(cdkDir)).resolves.toBeUndefined();
  });

  it('lets the environment override the project config', async () => {
    const cdkDir = writeProject(baseSpec({ permissionsBoundary: BOUNDARY_NAME }));
    process.env[PERMISSIONS_BOUNDARY_ENV_VAR] = 'FromEnv';

    await expect(readPermissionsBoundary(cdkDir)).resolves.toBe('FromEnv');
  });

  it('lets an explicit override win over the environment', async () => {
    const cdkDir = writeProject(baseSpec({ permissionsBoundary: BOUNDARY_NAME }));
    process.env[PERMISSIONS_BOUNDARY_ENV_VAR] = 'FromEnv';

    await expect(readPermissionsBoundary(cdkDir, 'FromOverride')).resolves.toBe('FromOverride');
  });

  it('still honours the environment when agentcore.json is missing', async () => {
    const cdkDir = join(tmpRoot, 'no-such-project', CONFIG_DIR, CDK_PROJECT_DIR);
    process.env[PERMISSIONS_BOUNDARY_ENV_VAR] = 'FromEnv';

    await expect(readPermissionsBoundary(cdkDir)).resolves.toBe('FromEnv');
  });

  it('falls back to the machine global config when the project declares none', async () => {
    const cdkDir = writeProject(baseSpec());
    readGlobalConfigMock.mockResolvedValue({ success: true, config: { permissionsBoundary: BOUNDARY_NAME } });

    await expect(readPermissionsBoundary(cdkDir)).resolves.toBe(BOUNDARY_NAME);
  });

  it('lets the project config override the machine global config', async () => {
    const cdkDir = writeProject(baseSpec({ permissionsBoundary: 'FromProject' }));
    readGlobalConfigMock.mockResolvedValue({ success: true, config: { permissionsBoundary: 'FromGlobal' } });

    await expect(readPermissionsBoundary(cdkDir)).resolves.toBe('FromProject');
  });

  it('ignores an unreadable global config', async () => {
    const cdkDir = writeProject(baseSpec());
    readGlobalConfigMock.mockResolvedValue({ success: false, error: new Error('bad json') });

    await expect(readPermissionsBoundary(cdkDir)).resolves.toBeUndefined();
  });

  // The state `agentcore config permissionsBoundary ''` leaves behind.
  it('treats a blank global config value as no boundary', async () => {
    const cdkDir = writeProject(baseSpec());
    readGlobalConfigMock.mockResolvedValue({ success: true, config: { permissionsBoundary: '' } });

    await expect(readPermissionsBoundary(cdkDir)).resolves.toBeUndefined();
  });
});

describe('readPermissionsBoundaryContext', () => {
  it('produces the CDK context entry for a configured boundary', async () => {
    const cdkDir = writeProject(baseSpec({ permissionsBoundary: BOUNDARY_NAME }));

    await expect(readPermissionsBoundaryContext(cdkDir)).resolves.toEqual({
      [CDK_PERMISSIONS_BOUNDARY_CONTEXT_KEY]: { name: BOUNDARY_NAME },
    });
  });

  it('produces no context when no boundary is configured', async () => {
    const cdkDir = writeProject(baseSpec());

    await expect(readPermissionsBoundaryContext(cdkDir)).resolves.toBeUndefined();
  });
});

describe('rewriteIfPermissionsBoundaryRequired', () => {
  const REQUIRED_ARN = 'arn:aws:iam::111122223333:policy/OrgBoundary';

  /** Real CloudFormation status reason for this failure, abridged. */
  const cfnDenial =
    'Resource handler returned message: "Encountered a permissions error performing a tagging ' +
    'operation, please add required tag permissions. Resource handler returned message: "User: ' +
    'arn:aws:sts::111122223333:assumed-role/cdk-hnb659fds-cfn-exec-role-111122223333-us-east-1/AWSCloudFormation ' +
    'is not authorized to perform: iam:CreateRole on resource: ' +
    'arn:aws:iam::111122223333:role/AgentCore-proj-default-ApplicationAgentMyAgentRu-abc123 ' +
    `with an explicit deny in a permissions boundary: ${REQUIRED_ARN} ` +
    '(Service: Iam, Status Code: 403, Request ID: 1234)"" (HandlerErrorCode: UnauthorizedTaggingOperation)';

  /** Real CDK_TOOLKIT_I5502 progress message for the same failure, abridged. */
  const progressDenial =
    'AgentCore-proj-default | 1/5 | 11:03:16 AM | CREATE_FAILED | AWS::IAM::Role | ' +
    'Application/AgentMyAgent/Runtime/ExecutionRole (ApplicationAgentMyAgentRuntimeExecutionRole5E90F22B) ' +
    `${cfnDenial}`;

  it('rewrites a flat denial and extracts the required boundary', () => {
    const rewritten = rewriteIfPermissionsBoundaryRequired(new Error(cfnDenial));

    expect(rewritten).toBeInstanceOf(PermissionsBoundaryRequiredError);
    const err = rewritten as PermissionsBoundaryRequiredError;
    expect(err.requiredBoundaryArn).toBe(REQUIRED_ARN);
    expect(err.errorSource).toBe('user');
    expect(err.cause).toBeInstanceOf(Error);
  });

  it('finds the denial through a nested cause chain', () => {
    const wrapped = new Error('CDK deploy failed: deployment failed', {
      cause: new Error('❌ AgentCore-proj-default failed', { cause: new Error(cfnDenial) }),
    });

    const rewritten = rewriteIfPermissionsBoundaryRequired(wrapped);

    expect(rewritten).toBeInstanceOf(PermissionsBoundaryRequiredError);
    expect((rewritten as PermissionsBoundaryRequiredError).requiredBoundaryArn).toBe(REQUIRED_ARN);
  });

  it('names the mismatch when a boundary was already applied', () => {
    const message = (
      rewriteIfPermissionsBoundaryRequired(new Error(cfnDenial), { appliedBoundary: 'WrongBoundary' }) as Error
    ).message;

    expect(message).toContain('Applied:  WrongBoundary');
    expect(message).toContain(`Required: ${REQUIRED_ARN}`);
    // Must not claim the role had no boundary — it had one, just not the required one.
    expect(message).not.toContain('had none');
    // The setup instructions belong to the other branch only.
    expect(message).not.toContain('agentcore config permissionsBoundary');
  });

  // The shape this actually takes in practice: CloudFormation rolls the stack back and the
  // toolkit throws NoStack with no cause, so the reason is only on the captured progress message.
  it('rewrites a NoStack failure using a denial captured from progress messages', () => {
    const noStack = new Error(
      'CDK deploy failed: ❌  AgentCore-proj-default failed: NoStack: CloudFormationStack object does not hold a stack'
    );

    const rewritten = rewriteIfPermissionsBoundaryRequired(noStack, { observedDenial: progressDenial });

    expect(rewritten).toBeInstanceOf(PermissionsBoundaryRequiredError);
    expect((rewritten as PermissionsBoundaryRequiredError).requiredBoundaryArn).toBe(REQUIRED_ARN);
    expect((rewritten as Error).cause).toBe(noStack);
  });

  it('ignores a captured message that is not a boundary denial', () => {
    const err = new Error('NoStack: CloudFormationStack object does not hold a stack');

    expect(
      rewriteIfPermissionsBoundaryRequired(err, {
        observedDenial: 'CREATE_FAILED | AWS::IAM::Role | some other reason',
      })
    ).toBe(err);
  });

  it('tells the user how to set the boundary when none was applied', () => {
    const message = (rewriteIfPermissionsBoundaryRequired(new Error(cfnDenial)) as Error).message;

    expect(message).toContain(`agentcore config permissionsBoundary ${REQUIRED_ARN}`);
    expect(message).toContain('"iam": { "permissionsBoundary"');
  });

  it('still rewrites when the boundary ARN cannot be extracted', () => {
    const err = new Error(
      'is not authorized to perform: iam:CreateRole on resource: arn:aws:iam::111122223333:role/Foo ' +
        'with an explicit deny in a permissions boundary'
    );

    const rewritten = rewriteIfPermissionsBoundaryRequired(err);

    expect(rewritten).toBeInstanceOf(PermissionsBoundaryRequiredError);
    expect((rewritten as PermissionsBoundaryRequiredError).requiredBoundaryArn).toBeUndefined();
  });

  it('passes unrelated errors through untouched', () => {
    const err = new Error('CDK deploy failed: stack is in ROLLBACK_COMPLETE state');

    expect(rewriteIfPermissionsBoundaryRequired(err)).toBe(err);
  });

  it('leaves a boundary denial on a different action alone', () => {
    const err = new Error(
      'is not authorized to perform: iam:PutRolePermissionsBoundary on resource: ' +
        'arn:aws:iam::111122223333:role/Foo with an explicit deny in a permissions boundary: ' +
        REQUIRED_ARN
    );

    expect(rewriteIfPermissionsBoundaryRequired(err)).toBe(err);
  });

  it('leaves a plain CreateRole denial alone when no boundary is involved', () => {
    const err = new Error(
      'is not authorized to perform: iam:CreateRole on resource: arn:aws:iam::111122223333:role/Foo ' +
        'because no identity-based policy allows the iam:CreateRole action'
    );

    expect(rewriteIfPermissionsBoundaryRequired(err)).toBe(err);
  });

  it('survives a self-referential cause chain', () => {
    const err: Error & { cause?: unknown } = new Error('loop');
    err.cause = err;

    expect(() => rewriteIfPermissionsBoundaryRequired(err)).not.toThrow();
  });

  describe('isPermissionsBoundaryDenial', () => {
    it('recognizes both the handler error and the progress message', () => {
      expect(isPermissionsBoundaryDenial(cfnDenial)).toBe(true);
      expect(isPermissionsBoundaryDenial(progressDenial)).toBe(true);
    });

    it('requires both the action and the boundary phrase', () => {
      expect(isPermissionsBoundaryDenial('is not authorized to perform: iam:CreateRole')).toBe(false);
      expect(isPermissionsBoundaryDenial('explicit deny in a permissions boundary: arn:aws:iam::1:policy/B')).toBe(
        false
      );
      expect(isPermissionsBoundaryDenial('CREATE_IN_PROGRESS | AWS::IAM::Role | fine')).toBe(false);
    });
  });
});
