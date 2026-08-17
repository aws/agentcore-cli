import type { AgentCoreProjectSpec } from '../../../../../schema';
import { getOrCreateABTestRole, resolveRuntimeTargetNames } from '../resolve';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockIamSend } = vi.hoisted(() => ({
  mockIamSend: vi.fn(),
}));

vi.mock('@aws-sdk/client-iam', () => ({
  IAMClient: class {
    send = mockIamSend;
  },
  CreateRoleCommand: class {
    constructor(public input: unknown) {}
  },
  GetRoleCommand: class {
    constructor(public input: unknown) {}
  },
  PutRolePolicyCommand: class {
    constructor(public input: unknown) {}
  },
  DeleteRolePolicyCommand: class {
    constructor(public input: unknown) {}
  },
  DeleteRoleCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock('../../../../aws/account', () => ({
  getCredentialProvider: vi.fn().mockReturnValue({}),
}));

const accountId = '123456789012';
const roleArn = `arn:aws:iam::${accountId}:role/AgentCore-Test-ABTestExperiment`;

interface TestTrustPolicy {
  Version: string;
  Statement: {
    Effect: string;
    Principal: Record<string, string>;
    Action: string;
    Condition?: {
      StringEquals: Record<string, string>;
      ArnLike: Record<string, string>;
    };
  }[];
}

function expectedTrustPolicy(): TestTrustPolicy {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { Service: 'bedrock-agentcore.amazonaws.com' },
        Action: 'sts:AssumeRole',
        Condition: {
          StringEquals: { 'aws:SourceAccount': accountId },
          ArnLike: { 'aws:SourceArn': `arn:aws:bedrock-agentcore:*:${accountId}:ab-test/*` },
        },
      },
    ],
  };
}

function roleOptions() {
  return {
    region: 'us-east-1',
    projectName: 'Test',
    testName: 'Experiment',
    gatewayArn: `arn:aws:bedrock-agentcore:us-east-1:${accountId}:gateway/test`,
    propagationDelayMs: 0,
  };
}

function entityAlreadyExistsError(): Error {
  return Object.assign(new Error('Role already exists'), { name: 'EntityAlreadyExistsException' });
}

describe('getOrCreateABTestRole', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a new role and applies its inline permissions policy', async () => {
    mockIamSend.mockResolvedValueOnce({ Role: { Arn: roleArn } }).mockResolvedValueOnce({});

    await expect(getOrCreateABTestRole(roleOptions())).resolves.toBe(roleArn);
    expect(mockIamSend).toHaveBeenCalledTimes(2);
  });

  it('reuses an existing role when its trust policy matches', async () => {
    mockIamSend
      .mockRejectedValueOnce(entityAlreadyExistsError())
      .mockResolvedValueOnce({
        Role: { Arn: roleArn, AssumeRolePolicyDocument: expectedTrustPolicy() },
      })
      .mockResolvedValueOnce({});

    await expect(getOrCreateABTestRole(roleOptions())).resolves.toBe(roleArn);
    expect(mockIamSend).toHaveBeenCalledTimes(3);
  });

  it('reuses an existing role with a URL-encoded matching trust policy', async () => {
    const encodedPolicy = encodeURIComponent(JSON.stringify(expectedTrustPolicy()));
    mockIamSend
      .mockRejectedValueOnce(entityAlreadyExistsError())
      .mockResolvedValueOnce({
        Role: { Arn: roleArn, AssumeRolePolicyDocument: encodedPolicy },
      })
      .mockResolvedValueOnce({});

    await expect(getOrCreateABTestRole(roleOptions())).resolves.toBe(roleArn);
    expect(mockIamSend).toHaveBeenCalledTimes(3);
  });

  it('rejects an existing role with an additional trusted principal', async () => {
    const trustPolicy = expectedTrustPolicy();
    trustPolicy.Statement.push({
      Effect: 'Allow',
      Principal: { AWS: `arn:aws:iam::${accountId}:user/attacker` },
      Action: 'sts:AssumeRole',
    });
    mockIamSend.mockRejectedValueOnce(entityAlreadyExistsError()).mockResolvedValueOnce({
      Role: { Arn: roleArn, AssumeRolePolicyDocument: trustPolicy },
    });

    await expect(getOrCreateABTestRole(roleOptions())).rejects.toThrow(/trust policy does not match/);
    expect(mockIamSend).toHaveBeenCalledTimes(2);
  });

  const weakenedConditions: [string, (policy: TestTrustPolicy) => void][] = [
    [
      'SourceAccount',
      policy => {
        policy.Statement[0]!.Condition!.StringEquals['aws:SourceAccount'] = '*';
      },
    ],
    [
      'SourceArn',
      policy => {
        policy.Statement[0]!.Condition!.ArnLike['aws:SourceArn'] = '*';
      },
    ],
  ];

  it.each(weakenedConditions)(
    'rejects an existing role with a weakened %s condition',
    async (_condition, weakenPolicy) => {
      const trustPolicy = expectedTrustPolicy();
      weakenPolicy(trustPolicy);
      mockIamSend.mockRejectedValueOnce(entityAlreadyExistsError()).mockResolvedValueOnce({
        Role: { Arn: roleArn, AssumeRolePolicyDocument: trustPolicy },
      });

      await expect(getOrCreateABTestRole(roleOptions())).rejects.toThrow(/trust policy does not match/);
      expect(mockIamSend).toHaveBeenCalledTimes(2);
    }
  );
});

type GatewaysOnly = Pick<AgentCoreProjectSpec, 'agentCoreGateways'>;

/** Project spec carrying only the gateway targets the resolver reads. */
function specWithTargets(targets: unknown[]): GatewaysOnly {
  return { agentCoreGateways: [{ name: 'my-gw', targets }] } as unknown as GatewaysOnly;
}

const httpTarget = (name: string, runtime: string) => ({
  name,
  targetType: 'httpRuntime',
  httpRuntime: { runtime },
});

describe('resolveRuntimeTargetNames', () => {
  it('returns the single httpRuntime target routing to the runtime', () => {
    const spec = specWithTargets([httpTarget('customer-support-ab', 'CustomerSupportAB')]);
    expect(resolveRuntimeTargetNames('my-gw', 'CustomerSupportAB', spec)).toEqual(['customer-support-ab']);
  });

  it('picks only the matching target when the gateway serves several runtimes', () => {
    const spec = specWithTargets([
      httpTarget('orders', 'OrdersAgent'),
      httpTarget('customer-support-ab', 'CustomerSupportAB'),
    ]);
    expect(resolveRuntimeTargetNames('my-gw', 'CustomerSupportAB', spec)).toEqual(['customer-support-ab']);
  });

  it('returns every matching target, in spec order, when several front one runtime', () => {
    const spec = specWithTargets([
      httpTarget('customer-support-ab', 'CustomerSupportAB'),
      httpTarget('customer-support-canary', 'CustomerSupportAB'),
    ]);
    expect(resolveRuntimeTargetNames('my-gw', 'CustomerSupportAB', spec)).toEqual([
      'customer-support-ab',
      'customer-support-canary',
    ]);
  });

  it('returns [] when no target routes to the runtime', () => {
    const spec = specWithTargets([httpTarget('orders', 'OrdersAgent')]);
    expect(resolveRuntimeTargetNames('my-gw', 'CustomerSupportAB', spec)).toEqual([]);
  });

  it('returns [] for a gateway with no targets', () => {
    expect(resolveRuntimeTargetNames('my-gw', 'CustomerSupportAB', specWithTargets([]))).toEqual([]);
  });

  // Only httpRuntime targets front a runtime; a same-named lambda/mcpServer target is not a route to it.
  it('ignores targets that are not httpRuntime', () => {
    const spec = specWithTargets([
      { name: 'customer-support-ab', targetType: 'lambda', httpRuntime: { runtime: 'CustomerSupportAB' } },
    ]);
    expect(resolveRuntimeTargetNames('my-gw', 'CustomerSupportAB', spec)).toEqual([]);
  });

  it('returns [] for an unknown gateway name', () => {
    const spec = specWithTargets([httpTarget('customer-support-ab', 'CustomerSupportAB')]);
    expect(resolveRuntimeTargetNames('other-gw', 'CustomerSupportAB', spec)).toEqual([]);
  });

  it('returns [] when the gateway or runtime is unset', () => {
    const spec = specWithTargets([httpTarget('customer-support-ab', 'CustomerSupportAB')]);
    expect(resolveRuntimeTargetNames(undefined, 'CustomerSupportAB', spec)).toEqual([]);
    expect(resolveRuntimeTargetNames('my-gw', undefined, spec)).toEqual([]);
  });

  it('returns [] when the project declares no gateways', () => {
    expect(resolveRuntimeTargetNames('my-gw', 'CustomerSupportAB', {} as GatewaysOnly)).toEqual([]);
  });
});
