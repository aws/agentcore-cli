import { StaleCdkConstructError } from '../../../../lib/errors/types.js';
import { extractUnknownKeys, formatError, rewriteIfStaleCdkConstruct, validateProject } from '../preflight.js';
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
      'No resources defined in project. Add at least one resource (agent, memory, knowledge base, evaluator, or gateway) before deploying.'
    );
  });

  it('allows deploy when only a knowledge base is defined (no agents or gateways)', async () => {
    mockRequireConfigRoot.mockReturnValue('/project/agentcore');
    mockValidate.mockReturnValue(undefined);
    mockReadProjectSpec.mockResolvedValue({
      name: 'test-project',
      runtimes: [],
      memories: [],
      knowledgeBases: [
        {
          type: 'AgentCoreKnowledgeBase',
          name: 'docs',
          dataSources: [{ type: 'S3', uri: 's3://my-bucket/' }],
        },
      ],
      agentCoreGateways: [],
    });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockValidateAwsCredentials.mockResolvedValue(undefined);

    const result = await validateProject();

    expect(result.projectSpec.name).toBe('test-project');
    expect(result.isTeardownDeploy).toBe(false);
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

  it('allows deploy when datasets exist but no agents or gateways', async () => {
    mockRequireConfigRoot.mockReturnValue('/project/agentcore');
    mockValidate.mockReturnValue(undefined);
    mockReadProjectSpec.mockResolvedValue({
      name: 'test-project',
      runtimes: [],
      memories: [],
      knowledgeBases: [],
      datasets: [
        {
          name: 'test-dataset',
          schemaType: 'AGENTCORE_EVALUATION_PREDEFINED_V1',
          config: { managed: { location: 'datasets/test.jsonl' } },
        },
      ],
      agentCoreGateways: [],
    });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockValidateAwsCredentials.mockResolvedValue(undefined);

    const result = await validateProject();

    expect(result.projectSpec.name).toBe('test-project');
    expect(result.isTeardownDeploy).toBe(false);
  });

  it('allows deploy when only config bundles are defined (regression: previously misclassified as empty)', async () => {
    mockRequireConfigRoot.mockReturnValue('/project/agentcore');
    mockValidate.mockReturnValue(undefined);
    mockReadProjectSpec.mockResolvedValue({
      name: 'test-project',
      runtimes: [],
      agentCoreGateways: [],
      configBundles: [{ name: 'bundle1' }],
    });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockValidateAwsCredentials.mockResolvedValue(undefined);

    const result = await validateProject();

    expect(result.projectSpec.name).toBe('test-project');
    expect(result.isTeardownDeploy).toBe(false);
  });

  it('allows deploy when only online eval configs are defined (regression: previously misclassified as empty)', async () => {
    mockRequireConfigRoot.mockReturnValue('/project/agentcore');
    mockValidate.mockReturnValue(undefined);
    mockReadProjectSpec.mockResolvedValue({
      name: 'test-project',
      runtimes: [],
      agentCoreGateways: [],
      onlineEvalConfigs: [{ name: 'oec1' }],
    });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockValidateAwsCredentials.mockResolvedValue(undefined);

    const result = await validateProject();

    expect(result.projectSpec.name).toBe('test-project');
    expect(result.isTeardownDeploy).toBe(false);
  });

  it('allows deploy when only capacity providers are defined', async () => {
    mockRequireConfigRoot.mockReturnValue('/project/agentcore');
    mockValidate.mockReturnValue(undefined);
    mockReadProjectSpec.mockResolvedValue({
      name: 'test-project',
      runtimes: [],
      agentCoreGateways: [],
      capacityProviders: [{ name: 'cp1' }],
    });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockValidateAwsCredentials.mockResolvedValue(undefined);

    const result = await validateProject();

    expect(result.projectSpec.name).toBe('test-project');
    expect(result.isTeardownDeploy).toBe(false);
  });

  it('treats an empty project as teardown when a deployed stack exists', async () => {
    mockRequireConfigRoot.mockReturnValue('/project/agentcore');
    mockValidate.mockReturnValue(undefined);
    mockReadProjectSpec.mockResolvedValue({
      name: 'test-project',
      runtimes: [],
      agentCoreGateways: [],
    });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockReadDeployedState.mockResolvedValue({ targets: { default: {} } });

    const result = await validateProject();

    expect(result.isTeardownDeploy).toBe(true);
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

  it('validates credentials against the selected deployment target', async () => {
    const selectedTarget = { name: 'prod', account: '222222222222', region: 'us-east-1' } as const;
    mockRequireConfigRoot.mockReturnValue('/project/agentcore');
    mockValidate.mockReturnValue(undefined);
    mockReadProjectSpec.mockResolvedValue({
      name: 'test-project',
      runtimes: [{ name: 'test-agent' }],
      agentCoreGateways: [],
    });
    mockReadAWSDeploymentTargets.mockResolvedValue([
      { name: 'default', account: '111111111111', region: 'us-west-2' },
      selectedTarget,
    ]);
    mockValidateAwsCredentials.mockResolvedValue(undefined);

    await validateProject(selectedTarget);

    expect(mockValidateAwsCredentials).toHaveBeenCalledWith(selectedTarget);
  });

  it('validates credentials against the first target when none is selected', async () => {
    const firstTarget = { name: 'default', account: '111111111111', region: 'us-west-2' } as const;
    mockRequireConfigRoot.mockReturnValue('/project/agentcore');
    mockValidate.mockReturnValue(undefined);
    mockReadProjectSpec.mockResolvedValue({
      name: 'test-project',
      runtimes: [{ name: 'test-agent' }],
      agentCoreGateways: [],
    });
    mockReadAWSDeploymentTargets.mockResolvedValue([firstTarget]);
    mockValidateAwsCredentials.mockResolvedValue(undefined);

    await validateProject();

    expect(mockValidateAwsCredentials).toHaveBeenCalledWith(firstTarget);
  });

  it('accepts gateway target name within 48 chars when prefixed with project name', async () => {
    mockRequireConfigRoot.mockReturnValue('/project/agentcore');
    mockValidate.mockReturnValue(undefined);
    // projectName "myproject" (9) + "-" (1) + targetName (38) = 48 == limit
    mockReadProjectSpec.mockResolvedValue({
      name: 'myproject',
      runtimes: [],
      agentCoreGateways: [{ name: 'gw' }],
    });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockValidateAwsCredentials.mockResolvedValue(undefined);

    const result = await validateProject();
    expect(result.projectSpec.name).toBe('myproject');
  });

  it('rejects a gateway whose composed name exceeds 48 chars', async () => {
    mockRequireConfigRoot.mockReturnValue('/project/agentcore');
    mockValidate.mockReturnValue(undefined);
    // "ZeroTrustTodayACProj" (20) + "-" + "ZeroTrustTodayAgentCoreGateway" (30) = 51 > 48
    mockReadProjectSpec.mockResolvedValue({
      name: 'ZeroTrustTodayACProj',
      runtimes: [],
      agentCoreGateways: [{ name: 'ZeroTrustTodayAgentCoreGateway' }],
    });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockValidateAwsCredentials.mockResolvedValue(undefined);

    await expect(validateProject()).rejects.toThrow(
      'Gateway name too long: "ZeroTrustTodayACProj-ZeroTrustTodayAgentCoreGateway" (51 chars).'
    );
  });

  it('accepts a composed gateway name exactly at the 48-char limit', async () => {
    mockRequireConfigRoot.mockReturnValue('/project/agentcore');
    mockValidate.mockReturnValue(undefined);
    // "proj" (4) + "-" (1) + 43-char name = 48 == limit
    mockReadProjectSpec.mockResolvedValue({
      name: 'proj',
      runtimes: [],
      agentCoreGateways: [{ name: 'a'.repeat(43) }],
    });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockValidateAwsCredentials.mockResolvedValue(undefined);

    const result = await validateProject();
    expect(result.projectSpec.name).toBe('proj');
  });

  it('skips the length check for imported gateways that carry an explicit resourceName', async () => {
    mockRequireConfigRoot.mockReturnValue('/project/agentcore');
    mockValidate.mockReturnValue(undefined);
    // Composed name would be 51 chars, but resourceName is AWS-accepted already → skip.
    mockReadProjectSpec.mockResolvedValue({
      name: 'ZeroTrustTodayACProj',
      runtimes: [],
      agentCoreGateways: [{ name: 'ZeroTrustTodayAgentCoreGateway', resourceName: 'short-existing-gw' }],
    });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockValidateAwsCredentials.mockResolvedValue(undefined);

    const result = await validateProject();
    expect(result.projectSpec.name).toBe('ZeroTrustTodayACProj');
  });
});

describe('formatError', () => {
  it('formats a simple Error', () => {
    const err = new Error('Something went wrong');
    const result = formatError(err);
    expect(result).toContain('Something went wrong');
  });

  it('omits the stack trace by default but includes it under AGENTCORE_DEBUG', () => {
    const err = new Error('oops');
    expect(formatError(err)).not.toContain('Stack trace:');
    expect(formatError(err)).toContain('oops');

    const prev = process.env.AGENTCORE_DEBUG;
    process.env.AGENTCORE_DEBUG = '1';
    try {
      expect(formatError(new Error('oops'))).toContain('Stack trace:');
    } finally {
      if (prev === undefined) delete process.env.AGENTCORE_DEBUG;
      else process.env.AGENTCORE_DEBUG = prev;
    }
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

describe('extractUnknownKeys', () => {
  it('extracts a single rejected key', () => {
    const err = new Error('agentCoreGateways[0]: unknown keys (remove): "protocolType"');
    expect(extractUnknownKeys(err)).toEqual(['protocolType']);
  });

  it('extracts multiple rejected keys', () => {
    const err = new Error('agentCoreGateways[0]: unknown keys (remove): "protocolType", "newField"');
    expect(extractUnknownKeys(err)).toEqual(['protocolType', 'newField']);
  });

  it('finds the key when nested in a cause chain (how it reaches the CLI)', () => {
    const cause = new Error('agentcore.json:\n - agentCoreGateways[0]: unknown keys (remove): "protocolType"');
    const wrapped = new Error('CDK synth failed: Subprocess exited with error 1', { cause });
    expect(extractUnknownKeys(wrapped)).toEqual(['protocolType']);
  });

  it('returns [] for unrelated synth errors', () => {
    expect(extractUnknownKeys(new Error('CDK synth failed: bad region'))).toEqual([]);
  });
});

describe('rewriteIfStaleCdkConstruct', () => {
  it('rewrites an unknown-keys synth failure into a StaleCdkConstructError with a fix hint', () => {
    const err = new Error('agentCoreGateways[0]: unknown keys (remove): "protocolType"');
    const rewritten = rewriteIfStaleCdkConstruct(err, '/project/agentcore/cdk');
    expect(rewritten).toBeInstanceOf(StaleCdkConstructError);
    const message = (rewritten as Error).message;
    expect(message).toContain('"protocolType"');
    expect(message).toContain('npm update @aws/agentcore-cdk');
    // Original error is preserved as the cause for debugging.
    expect((rewritten as Error).cause).toBe(err);
  });

  it('passes unrelated synth errors through untouched', () => {
    const err = new Error('CDK synth failed: insufficient permissions');
    const result = rewriteIfStaleCdkConstruct(err, '/project/agentcore/cdk');
    expect(result).toBe(err);
    expect(result).not.toBeInstanceOf(StaleCdkConstructError);
  });

  it('normalizes a non-Error throw into an Error when not an unknown-keys failure', () => {
    const result = rewriteIfStaleCdkConstruct('some string failure', '/project/agentcore/cdk');
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe('some string failure');
  });
});
