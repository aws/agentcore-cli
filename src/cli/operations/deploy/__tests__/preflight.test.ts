import { formatError, validateProject } from '../preflight.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Import the actual AccountMismatchError for use in tests
const { AccountMismatchError } = await import('../../../aws/account.js');

const { mockReadProjectSpec, mockReadAWSDeploymentTargets, mockReadDeployedState, mockConfigExists } = vi.hoisted(
  () => ({
    mockReadProjectSpec: vi.fn(),
    mockReadAWSDeploymentTargets: vi.fn(),
    mockReadDeployedState: vi.fn(),
    mockConfigExists: vi.fn(),
  })
);

const { mockValidate } = vi.hoisted(() => ({
  mockValidate: vi.fn(),
}));

const { mockValidateAwsCredentials, mockValidateAccountMatch } = vi.hoisted(() => ({
  mockValidateAwsCredentials: vi.fn(),
  mockValidateAccountMatch: vi.fn(),
}));

const { mockRequireConfigRoot } = vi.hoisted(() => ({
  mockRequireConfigRoot: vi.fn(),
}));

vi.mock('../../../../lib/index.js', () => ({
  ConfigIO: class {
    constructor(_options?: { baseDir?: string }) {
      // mock constructor
    }
    readProjectSpec = mockReadProjectSpec;
    readAWSDeploymentTargets = mockReadAWSDeploymentTargets;
    resolveAWSDeploymentTargets = mockReadAWSDeploymentTargets;
    readDeployedState = mockReadDeployedState;
    configExists = mockConfigExists;
  },
  requireConfigRoot: mockRequireConfigRoot,
}));

vi.mock('../../../cdk/local-cdk-project.js', () => ({
  LocalCdkProject: class {
    validate = mockValidate;
  },
}));

vi.mock('../../../aws/account.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../aws/account.js')>();
  return {
    ...actual,
    validateAwsCredentials: mockValidateAwsCredentials,
    validateAccountMatch: mockValidateAccountMatch,
  };
});

describe('validateProject', () => {
  afterEach(() => vi.clearAllMocks());

  it('allows deploy when gateways exist but no agents', async () => {
    mockRequireConfigRoot.mockReturnValue('/project/agentcore');
    mockValidate.mockReturnValue(undefined);
    mockReadProjectSpec.mockResolvedValue({
      name: 'test-project',
      runtimes: [],
      agentCoreGateways: [{ name: 'test-gateway' }],
    });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockValidateAwsCredentials.mockResolvedValue(undefined);

    const result = await validateProject();

    expect(result.projectSpec.name).toBe('test-project');
    expect(result.isTeardownDeploy).toBe(false);
  });

  it('blocks deploy when no agents and no gateways', async () => {
    mockRequireConfigRoot.mockReturnValue('/project/agentcore');
    mockValidate.mockReturnValue(undefined);
    mockReadProjectSpec.mockResolvedValue({
      name: 'test-project',
      runtimes: [],
      agentCoreGateways: [],
    });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockReadDeployedState.mockRejectedValue(new Error('No deployed state'));

    await expect(validateProject()).rejects.toThrow(
      'No resources defined in project. Add at least one resource (agent, memory, evaluator, or gateway) before deploying.'
    );
  });

  it('allows deploy when memories exist but no agents or gateways', async () => {
    mockRequireConfigRoot.mockReturnValue('/project/agentcore');
    mockValidate.mockReturnValue(undefined);
    mockReadProjectSpec.mockResolvedValue({
      name: 'test-project',
      runtimes: [],
      memories: [{ name: 'test-memory', strategies: [] }],
      agentCoreGateways: [],
    });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockValidateAwsCredentials.mockResolvedValue(undefined);

    const result = await validateProject();

    expect(result.projectSpec.name).toBe('test-project');
    expect(result.isTeardownDeploy).toBe(false);
  });

  it('allows deploy when both agents and gateways exist', async () => {
    mockRequireConfigRoot.mockReturnValue('/project/agentcore');
    mockValidate.mockReturnValue(undefined);
    mockReadProjectSpec.mockResolvedValue({
      name: 'test-project',
      runtimes: [{ name: 'test-agent' }],
      agentCoreGateways: [{ name: 'test-gateway' }],
    });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockValidateAwsCredentials.mockResolvedValue(undefined);

    const result = await validateProject();

    expect(result.projectSpec.name).toBe('test-project');
    expect(result.isTeardownDeploy).toBe(false);
  });

  it('throws AccountMismatchError when credentials account does not match target', async () => {
    mockRequireConfigRoot.mockReturnValue('/project/agentcore');
    mockValidate.mockReturnValue(undefined);
    mockReadProjectSpec.mockResolvedValue({
      name: 'test-project',
      runtimes: [{ name: 'test-agent' }],
    });
    mockReadAWSDeploymentTargets.mockResolvedValue([{ name: 'prod', account: '222222222222', region: 'us-east-1' }]);
    mockValidateAccountMatch.mockRejectedValue(new AccountMismatchError('111111111111', '222222222222', 'prod'));

    await expect(validateProject()).rejects.toThrow(AccountMismatchError);
    await expect(validateProject()).rejects.toThrow('111111111111');
    expect(mockValidateAccountMatch).toHaveBeenCalledWith('222222222222', 'prod');
  });

  it('calls validateAccountMatch with first target when targets exist', async () => {
    mockRequireConfigRoot.mockReturnValue('/project/agentcore');
    mockValidate.mockReturnValue(undefined);
    mockReadProjectSpec.mockResolvedValue({
      name: 'test-project',
      runtimes: [{ name: 'test-agent' }],
    });
    mockReadAWSDeploymentTargets.mockResolvedValue([
      { name: 'prod', account: '123456789012', region: 'us-east-1' },
      { name: 'staging', account: '987654321098', region: 'us-west-2' },
    ]);
    mockValidateAccountMatch.mockResolvedValue(undefined);

    await validateProject();

    // Should validate against first target only
    expect(mockValidateAccountMatch).toHaveBeenCalledTimes(1);
    expect(mockValidateAccountMatch).toHaveBeenCalledWith('123456789012', 'prod');
  });

  it('calls validateAwsCredentials when no targets configured', async () => {
    mockRequireConfigRoot.mockReturnValue('/project/agentcore');
    mockValidate.mockReturnValue(undefined);
    mockReadProjectSpec.mockResolvedValue({
      name: 'test-project',
      runtimes: [{ name: 'test-agent' }],
    });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockValidateAwsCredentials.mockResolvedValue(undefined);

    await validateProject();

    expect(mockValidateAwsCredentials).toHaveBeenCalled();
    expect(mockValidateAccountMatch).not.toHaveBeenCalled();
  });

  it('skips credential validation for teardown deploys', async () => {
    mockRequireConfigRoot.mockReturnValue('/project/agentcore');
    mockValidate.mockReturnValue(undefined);
    mockReadProjectSpec.mockResolvedValue({
      name: 'test-project',
      runtimes: [], // No agents - triggers teardown check
    });
    mockReadAWSDeploymentTargets.mockResolvedValue([{ name: 'prod', account: '123456789012', region: 'us-east-1' }]);
    // Mock deployed state exists with targets (makes it a teardown deploy)
    mockReadDeployedState.mockResolvedValue({
      targets: { prod: { runtimes: [{ runtimeId: 'abc' }] } },
    });

    const result = await validateProject();

    // Should be a teardown deploy
    expect(result.isTeardownDeploy).toBe(true);
    // Should NOT call credential validation (deferred until after confirmation)
    expect(mockValidateAccountMatch).not.toHaveBeenCalled();
    expect(mockValidateAwsCredentials).not.toHaveBeenCalled();
  });
});

describe('formatError', () => {
  it('formats a simple Error', () => {
    const err = new Error('Something went wrong');
    const result = formatError(err);
    expect(result).toContain('Something went wrong');
  });

  it('includes stack trace when present', () => {
    const err = new Error('oops');
    const result = formatError(err);
    expect(result).toContain('Stack trace:');
    expect(result).toContain('oops');
  });

  it('formats nested cause errors', () => {
    const cause = new Error('root cause');
    const err = new Error('outer error', { cause });
    const result = formatError(err);
    expect(result).toContain('outer error');
    expect(result).toContain('Caused by:');
    expect(result).toContain('root cause');
  });

  it('formats non-Error values using String()', () => {
    expect(formatError('string error')).toBe('string error');
    expect(formatError(42)).toBe('42');
    expect(formatError(null)).toBe('null');
    expect(formatError(undefined)).toBe('undefined');
  });

  it('handles Error without stack', () => {
    const err = new Error('no stack');
    err.stack = undefined;
    const result = formatError(err);
    expect(result).toBe('no stack');
    expect(result).not.toContain('Stack trace:');
  });

  it('handles deeply nested causes', () => {
    const inner = new Error('inner');
    const mid = new Error('mid', { cause: inner });
    const outer = new Error('outer', { cause: mid });
    const result = formatError(outer);
    expect(result).toContain('outer');
    expect(result).toContain('mid');
    expect(result).toContain('inner');
  });
});
