import type { AgentCoreProjectSpec, Policy, PolicyEngine } from '../../../schema';
import { PolicyPrimitive } from '../PolicyPrimitive';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const engine: PolicyEngine = { name: 'eng', policies: [] };

const defaultProject: AgentCoreProjectSpec = {
  name: 'test',
  version: 1,
  managedBy: 'CDK' as const,
  runtimes: [],
  memories: [],
  knowledgeBases: [],
  credentials: [],
  evaluators: [],
  onlineEvalConfigs: [],
  agentCoreGateways: [],
  policyEngines: [engine],
  configBundles: [],
  abTests: [],
  harnesses: [],
  datasets: [],
  payments: [],
};

const { mockConfigExists, mockReadProjectSpec, mockWriteProjectSpec, mockReadDeployedState } = vi.hoisted(() => ({
  mockConfigExists: vi.fn().mockReturnValue(true),
  mockReadProjectSpec: vi.fn(),
  mockWriteProjectSpec: vi.fn().mockResolvedValue(undefined),
  mockReadDeployedState: vi.fn(),
}));

const { mockStartPolicyGeneration, mockGetPolicyGeneration } = vi.hoisted(() => ({
  mockStartPolicyGeneration: vi.fn().mockResolvedValue({ generationId: 'gen-1' }),
  mockGetPolicyGeneration: vi
    .fn()
    .mockResolvedValue({ status: 'COMPLETED', statement: 'permit(principal, action, resource);' }),
}));

vi.mock('../../aws/policy-generation', () => ({
  startPolicyGeneration: mockStartPolicyGeneration,
  getPolicyGeneration: mockGetPolicyGeneration,
}));

vi.mock('../../aws', () => ({
  detectRegion: vi.fn().mockResolvedValue({ region: 'us-west-2' }),
}));

vi.mock('../../../lib', () => {
  const MockConfigIO = vi.fn(function (this: Record<string, unknown>) {
    this.configExists = mockConfigExists;
    this.readProjectSpec = mockReadProjectSpec;
    this.writeProjectSpec = mockWriteProjectSpec;
    this.readDeployedState = mockReadDeployedState;
  });
  return {
    ConfigIO: MockConfigIO,
    findConfigRoot: vi.fn().mockReturnValue('/fake/root'),
    setEnvVar: vi.fn().mockResolvedValue(undefined),
    toError: (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
    serializeResult: (r: unknown) => r,
    ValidationError: class extends Error {
      constructor(m: string) {
        super(m);
        this.name = 'ValidationError';
      }
    },
    ResourceNotFoundError: class extends Error {
      constructor(m: string) {
        super(m);
        this.name = 'ResourceNotFoundError';
      }
    },
  };
});

/** Extract the first policy written to the engine on writeProjectSpec. */
function getWrittenPolicy(): Policy {
  expect(mockWriteProjectSpec).toHaveBeenCalledTimes(1);
  const spec = mockWriteProjectSpec.mock.calls[0]![0] as AgentCoreProjectSpec;
  const policy = spec.policyEngines[0]?.policies[0];
  expect(policy).toBeDefined();
  return policy!;
}

describe('PolicyPrimitive — enforcementMode', () => {
  let primitive: PolicyPrimitive;

  beforeEach(() => {
    vi.clearAllMocks();
    // Fresh engine each run so policies don't accumulate across tests
    mockReadProjectSpec.mockImplementation(() =>
      Promise.resolve({ ...defaultProject, policyEngines: [{ name: 'eng', policies: [] }] })
    );
    primitive = new PolicyPrimitive();
  });

  it('persists enforcementMode LOG_ONLY when provided', async () => {
    const result = await primitive.add({
      name: 'shadow',
      engine: 'eng',
      statement: 'forbid(principal, action, resource is AgentCore::Gateway);',
      enforcementMode: 'LOG_ONLY',
    });
    expect(result.success).toBe(true);
    expect(getWrittenPolicy().enforcementMode).toBe('LOG_ONLY');
  });

  it('persists enforcementMode ACTIVE when provided', async () => {
    const result = await primitive.add({
      name: 'active',
      engine: 'eng',
      statement: 'forbid(principal, action, resource is AgentCore::Gateway);',
      enforcementMode: 'ACTIVE',
    });
    expect(result.success).toBe(true);
    expect(getWrittenPolicy().enforcementMode).toBe('ACTIVE');
  });

  it('defaults enforcementMode to ACTIVE when omitted', async () => {
    const result = await primitive.add({
      name: 'defaulted',
      engine: 'eng',
      statement: 'forbid(principal, action, resource is AgentCore::Gateway);',
    });
    expect(result.success).toBe(true);
    expect(getWrittenPolicy().enforcementMode).toBe('ACTIVE');
  });
});

describe('PolicyPrimitive — --generate gateway resolution', () => {
  let primitive: PolicyPrimitive;

  const deployedEngine = {
    resources: { policyEngines: { eng: { policyEngineId: 'pe-1', policyEngineArn: 'arn:pe' } } },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockStartPolicyGeneration.mockResolvedValue({ generationId: 'gen-1' });
    mockGetPolicyGeneration.mockResolvedValue({
      status: 'COMPLETED',
      statement: 'permit(principal, action, resource);',
    });
    mockReadProjectSpec.mockImplementation(() =>
      Promise.resolve({ ...defaultProject, policyEngines: [{ name: 'eng', policies: [] }] })
    );
    primitive = new PolicyPrimitive();
  });

  it('resolves an MCP gateway stored under resources.mcp.gateways', async () => {
    mockReadDeployedState.mockResolvedValue({
      targets: {
        default: {
          resources: {
            ...deployedEngine.resources,
            mcp: { gateways: { 'my-gw': { gatewayId: 'g', gatewayArn: 'arn:mcp-gw' } } },
          },
        },
      },
    });
    const result = await primitive.add({ name: 'p', engine: 'eng', generate: 'Forbid X', gateway: 'my-gw' });
    expect(result.success).toBe(true);
    expect(mockStartPolicyGeneration).toHaveBeenCalledWith(expect.objectContaining({ resourceArn: 'arn:mcp-gw' }));
  });

  it('resolves an HTTP gateway stored under resources.gateways (the reported bug)', async () => {
    mockReadDeployedState.mockResolvedValue({
      targets: {
        default: {
          resources: {
            ...deployedEngine.resources,
            gateways: { 'my-gw': { gatewayId: 'g', gatewayArn: 'arn:http-gw' } },
          },
        },
      },
    });
    const result = await primitive.add({ name: 'p', engine: 'eng', generate: 'Forbid X', gateway: 'my-gw' });
    expect(result.success).toBe(true);
    expect(mockStartPolicyGeneration).toHaveBeenCalledWith(expect.objectContaining({ resourceArn: 'arn:http-gw' }));
  });

  it('resolves an HTTP gateway even when an MCP gateway coexists', async () => {
    mockReadDeployedState.mockResolvedValue({
      targets: {
        default: {
          resources: {
            ...deployedEngine.resources,
            mcp: { gateways: { 'mcp-gw': { gatewayId: 'm', gatewayArn: 'arn:mcp-gw' } } },
            gateways: { 'http-gw': { gatewayId: 'h', gatewayArn: 'arn:http-gw' } },
          },
        },
      },
    });
    const result = await primitive.add({ name: 'p', engine: 'eng', generate: 'Forbid X', gateway: 'http-gw' });
    expect(result.success).toBe(true);
    expect(mockStartPolicyGeneration).toHaveBeenCalledWith(expect.objectContaining({ resourceArn: 'arn:http-gw' }));
  });

  it('errors when the named gateway is not deployed', async () => {
    mockReadDeployedState.mockResolvedValue({
      targets: {
        default: {
          resources: {
            ...deployedEngine.resources,
            mcp: { gateways: { other: { gatewayId: 'o', gatewayArn: 'arn:other' } } },
          },
        },
      },
    });
    const result = await primitive.add({ name: 'p', engine: 'eng', generate: 'Forbid X', gateway: 'missing' });
    expect(result.success).toBe(false);
    expect(result.success ? '' : result.error.message).toContain('not found in deployed state');
  });
});
