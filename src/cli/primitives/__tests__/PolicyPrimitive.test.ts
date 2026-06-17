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

const { mockConfigExists, mockReadProjectSpec, mockWriteProjectSpec } = vi.hoisted(() => ({
  mockConfigExists: vi.fn().mockReturnValue(true),
  mockReadProjectSpec: vi.fn(),
  mockWriteProjectSpec: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../lib', () => {
  const MockConfigIO = vi.fn(function (this: Record<string, unknown>) {
    this.configExists = mockConfigExists;
    this.readProjectSpec = mockReadProjectSpec;
    this.writeProjectSpec = mockWriteProjectSpec;
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
