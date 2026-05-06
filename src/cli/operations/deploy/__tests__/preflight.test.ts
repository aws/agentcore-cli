import { formatError, validateProject } from '../preflight.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

const { mockValidateAwsCredentials } = vi.hoisted(() => ({
  mockValidateAwsCredentials: vi.fn(),
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
    getPathResolver = () => ({ getAgentConfigPath: () => '/tmp/mock-agentcore.json' });
  },
  requireConfigRoot: mockRequireConfigRoot,
}));

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: () => JSON.stringify({}),
    writeFileSync: vi.fn(),
  };
});

vi.mock('../../../cdk/local-cdk-project.js', () => ({
  LocalCdkProject: class {
    validate = mockValidate;
  },
}));

vi.mock('../../../aws/account.js', () => ({
  validateAwsCredentials: mockValidateAwsCredentials,
}));

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
      'No resources defined in project. Add at least one resource (agent, memory, evaluator, gateway, or harness) before deploying.'
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

  it('rejects gateway target name that exceeds 48 chars when prefixed with project name', async () => {
    mockRequireConfigRoot.mockReturnValue('/project/agentcore');
    mockValidate.mockReturnValue(undefined);
    // projectName "myproject" (9) + "-" (1) + targetName (39) = 49 > 48
    mockReadProjectSpec.mockResolvedValue({
      name: 'myproject',
      runtimes: [],
      httpGateways: [
        {
          name: 'gw',
          targets: [{ name: 'a'.repeat(39), runtimeRef: 'rt', qualifier: 'DEFAULT' }],
        },
      ],
      agentCoreGateways: [{ name: 'gw' }],
    });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockValidateAwsCredentials.mockResolvedValue(undefined);

    await expect(validateProject()).rejects.toThrow(
      'HTTP gateway target "' + 'a'.repeat(39) + '" in gateway "gw" would exceed the 48-character AWS limit'
    );
  });

  it('accepts gateway target name within 48 chars when prefixed with project name', async () => {
    mockRequireConfigRoot.mockReturnValue('/project/agentcore');
    mockValidate.mockReturnValue(undefined);
    // projectName "myproject" (9) + "-" (1) + targetName (38) = 48 == limit
    mockReadProjectSpec.mockResolvedValue({
      name: 'myproject',
      runtimes: [],
      httpGateways: [
        {
          name: 'gw',
          targets: [{ name: 'a'.repeat(38), runtimeRef: 'rt', qualifier: 'DEFAULT' }],
        },
      ],
      agentCoreGateways: [{ name: 'gw' }],
    });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockValidateAwsCredentials.mockResolvedValue(undefined);

    const result = await validateProject();
    expect(result.projectSpec.name).toBe('myproject');
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
