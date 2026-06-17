import type { AgentCoreProjectSpec } from '../../../schema';
import { GatewayTargetPrimitive } from '../GatewayTargetPrimitive';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  agentCoreGateways: [
    {
      name: 'my-gateway',
      targets: [],
      authorizerType: 'NONE',
      enableSemanticSearch: true,
      exceptionLevel: 'NONE',
    },
  ],
  policyEngines: [],
  configBundles: [],
  abTests: [],
  harnesses: [],
  datasets: [],
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
    requireConfigRoot: vi.fn().mockReturnValue('/fake/root'),
    setEnvVar: vi.fn().mockResolvedValue(undefined),
    toError: (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
    serializeResult: (r: unknown) => r,
    APP_DIR: 'app',
    MCP_APP_SUBDIR: 'mcp',
    ResourceNotFoundError: class extends Error {
      constructor(m: string) {
        super(m);
        this.name = 'ResourceNotFoundError';
      }
    },
    ValidationError: class extends Error {
      constructor(m: string) {
        super(m);
        this.name = 'ValidationError';
      }
    },
  };
});

/** Extract the written project spec targets for the gateway. */
function getWrittenGatewayTargets() {
  expect(mockWriteProjectSpec).toHaveBeenCalledTimes(1);
  const spec = mockWriteProjectSpec.mock.calls[0]![0] as AgentCoreProjectSpec;
  const gw = spec.agentCoreGateways[0];
  expect(gw).toBeDefined();
  return gw!.targets;
}

describe('GatewayTargetPrimitive', () => {
  let primitive: GatewayTargetPrimitive;

  beforeEach(() => {
    vi.clearAllMocks();
    mockReadProjectSpec.mockImplementation(() => Promise.resolve(JSON.parse(JSON.stringify(defaultProject))));
    primitive = new GatewayTargetPrimitive();
  });

  describe('createHttpRuntimeTarget', () => {
    it('writes correct nested httpRuntime structure to agentcore.json', async () => {
      await primitive.createHttpRuntimeTarget({
        name: 'my-http-target',
        gateway: 'my-gateway',
        runtime: 'my-agent',
      });

      const targets = getWrittenGatewayTargets();
      expect(targets).toHaveLength(1);
      expect(targets[0]).toEqual({
        name: 'my-http-target',
        targetType: 'httpRuntime',
        httpRuntime: { runtime: 'my-agent' },
      });
    });

    it('includes runtimeEndpoint when endpoint is specified', async () => {
      await primitive.createHttpRuntimeTarget({
        name: 'my-http-target',
        gateway: 'my-gateway',
        runtime: 'my-agent',
        endpoint: 'LIVE',
      });

      const targets = getWrittenGatewayTargets();
      expect(targets[0]).toEqual({
        name: 'my-http-target',
        targetType: 'httpRuntime',
        httpRuntime: { runtime: 'my-agent', runtimeEndpoint: 'LIVE' },
      });
    });

    it('includes outboundAuth when OAUTH is specified', async () => {
      await primitive.createHttpRuntimeTarget({
        name: 'my-http-target',
        gateway: 'my-gateway',
        runtime: 'my-agent',
        outboundAuth: { type: 'OAUTH', credentialName: 'my-cred', scopes: ['read', 'write'] },
      });

      const targets = getWrittenGatewayTargets();
      expect(targets[0]).toEqual({
        name: 'my-http-target',
        targetType: 'httpRuntime',
        httpRuntime: { runtime: 'my-agent' },
        outboundAuth: { type: 'OAUTH', credentialName: 'my-cred', scopes: ['read', 'write'] },
      });
    });

    it('omits outboundAuth when type is NONE', async () => {
      await primitive.createHttpRuntimeTarget({
        name: 'my-http-target',
        gateway: 'my-gateway',
        runtime: 'my-agent',
        outboundAuth: { type: 'NONE' },
      });

      const targets = getWrittenGatewayTargets();
      expect(targets[0]!.outboundAuth).toBeUndefined();
    });

    it('throws error for duplicate target name', async () => {
      mockReadProjectSpec.mockImplementation(() =>
        Promise.resolve({
          ...JSON.parse(JSON.stringify(defaultProject)),
          agentCoreGateways: [
            {
              name: 'my-gateway',
              targets: [{ name: 'existing-target', targetType: 'httpRuntime', httpRuntime: { runtime: 'x' } }],
              authorizerType: 'NONE',
              enableSemanticSearch: true,
              exceptionLevel: 'NONE',
            },
          ],
        })
      );

      await expect(
        primitive.createHttpRuntimeTarget({
          name: 'existing-target',
          gateway: 'my-gateway',
          runtime: 'my-agent',
        })
      ).rejects.toThrow(/already exists/);
    });

    it('throws error for missing gateway', async () => {
      await expect(
        primitive.createHttpRuntimeTarget({
          name: 'my-http-target',
          gateway: 'non-existent-gateway',
          runtime: 'my-agent',
        })
      ).rejects.toThrow(/not found/);
    });
  });
});

// ============================================================================
// Connector gateway-target tests — use spy-based mocks (different style from
// the hoisted vi.mock above). Both styles compose cleanly because the spies
// only attach to instances created inside makePrimitive().
// ============================================================================

function emptyProject(): AgentCoreProjectSpec {
  return {
    version: '1.0',
    name: 'TestProj',
    runtimes: [],
    memories: [],
    credentials: [],
    evaluators: [],
    onlineEvalConfigs: [],
    policyEngines: [],
    datasets: [],
    agentCoreGateways: [
      {
        name: 'main-gw',
        targets: [],
        authorizerType: 'NONE',
        enableSemanticSearch: true,
        exceptionLevel: 'NONE',
      },
    ],
    knowledgeBases: [],
  } as unknown as AgentCoreProjectSpec;
}

function makePrimitive(initial: AgentCoreProjectSpec) {
  const primitive = new GatewayTargetPrimitive();
  let project = initial;
  vi.spyOn(
    primitive as unknown as { readProjectSpec: () => Promise<AgentCoreProjectSpec> },
    'readProjectSpec'
  ).mockImplementation(() => Promise.resolve(project));
  vi.spyOn(
    primitive as unknown as { writeProjectSpec: (p: AgentCoreProjectSpec) => Promise<void> },
    'writeProjectSpec'
  ).mockImplementation((p: AgentCoreProjectSpec) => {
    project = p;
    return Promise.resolve();
  });
  return { primitive, getProject: () => project };
}

describe('GatewayTargetPrimitive — createConnectorGatewayTarget', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes a single-KB Retrieve target for bedrock-knowledge-bases', async () => {
    const { primitive, getProject } = makePrimitive(emptyProject());
    const result = await primitive.createConnectorGatewayTarget({
      targetType: 'connector',
      name: 'product-docs',
      gateway: 'main-gw',
      connectorId: 'bedrock-knowledge-bases',
      knowledgeBaseId: 'ABCDEFGHIJ',
    });
    expect(result.toolName).toBe('product-docs');
    const targets = getProject().agentCoreGateways[0]?.targets ?? [];
    const retrieve = targets.find(t => t.connectorId === 'bedrock-knowledge-bases');
    expect(retrieve?.connectorId).toBe('bedrock-knowledge-bases');
    expect(retrieve?.knowledgeBaseId).toBe('ABCDEFGHIJ');
    expect(retrieve?.knowledgeBaseIds).toBeUndefined();
  });

  it('bedrock-knowledge-bases create also upserts a shared agentic-retrieve target', async () => {
    const { primitive, getProject } = makePrimitive(emptyProject());
    await primitive.createConnectorGatewayTarget({
      targetType: 'connector',
      name: 'product-docs',
      gateway: 'main-gw',
      connectorId: 'bedrock-knowledge-bases',
      knowledgeBaseId: 'ABCDEFGHIJ',
    });
    const targets = getProject().agentCoreGateways[0]?.targets ?? [];
    expect(targets).toHaveLength(2);
    const retrieve = targets.find(t => t.connectorId === 'bedrock-knowledge-bases');
    expect(retrieve?.name).toBe('product-docs');
    expect(retrieve?.knowledgeBaseId).toBe('ABCDEFGHIJ');
    const agentic = targets.find(t => t.connectorId === 'bedrock-agentic-retrieve');
    expect(agentic?.name).toBe('main-gw-agentic');
    expect(agentic?.knowledgeBaseIds).toEqual(['ABCDEFGHIJ']);
  });

  it('two bedrock-knowledge-bases creates share a single agentic target with both KBs', async () => {
    const { primitive, getProject } = makePrimitive(emptyProject());
    await primitive.createConnectorGatewayTarget({
      targetType: 'connector',
      name: 'docs-a',
      gateway: 'main-gw',
      connectorId: 'bedrock-knowledge-bases',
      knowledgeBaseId: 'ABCDEFGHIJ',
    });
    await primitive.createConnectorGatewayTarget({
      targetType: 'connector',
      name: 'docs-b',
      gateway: 'main-gw',
      connectorId: 'bedrock-knowledge-bases',
      knowledgeBaseId: 'KLMNOPQRST',
    });
    const targets = getProject().agentCoreGateways[0]?.targets ?? [];
    // Two Retrieve targets + one shared agentic target.
    expect(targets).toHaveLength(3);
    const agentics = targets.filter(t => t.connectorId === 'bedrock-agentic-retrieve');
    expect(agentics).toHaveLength(1);
    expect(agentics[0]?.knowledgeBaseIds).toEqual(['ABCDEFGHIJ', 'KLMNOPQRST']);
  });

  it('appends to an existing agentic target created earlier (e.g. via the KB primitive)', async () => {
    const initial = emptyProject();
    initial.agentCoreGateways[0]!.targets = [
      {
        name: 'main-gw-agentic',
        targetType: 'connector',
        connectorId: 'bedrock-agentic-retrieve',
        knowledgeBaseIds: ['existing-kb'],
      } as unknown as AgentCoreProjectSpec['agentCoreGateways'][0]['targets'][0],
    ];
    const { primitive, getProject } = makePrimitive(initial);
    await primitive.createConnectorGatewayTarget({
      targetType: 'connector',
      name: 'product-docs',
      gateway: 'main-gw',
      connectorId: 'bedrock-knowledge-bases',
      knowledgeBaseId: 'ABCDEFGHIJ',
    });
    const targets = getProject().agentCoreGateways[0]?.targets ?? [];
    const agentics = targets.filter(t => t.connectorId === 'bedrock-agentic-retrieve');
    expect(agentics).toHaveLength(1);
    expect(agentics[0]?.knowledgeBaseIds).toEqual(['existing-kb', 'ABCDEFGHIJ']);
    expect(targets.find(t => t.connectorId === 'bedrock-knowledge-bases')?.name).toBe('product-docs');
  });

  it('writes a fan-out agentic-retrieve target with knowledgeBaseIds[]', async () => {
    const { primitive, getProject } = makePrimitive(emptyProject());
    await primitive.createConnectorGatewayTarget({
      targetType: 'connector',
      name: 'agentic',
      gateway: 'main-gw',
      connectorId: 'bedrock-agentic-retrieve',
      knowledgeBaseIds: ['ABCDEFGHIJ', 'KLMNOPQRST'],
    });
    const target = getProject().agentCoreGateways[0]?.targets[0];
    expect(target?.connectorId).toBe('bedrock-agentic-retrieve');
    expect(target?.knowledgeBaseIds).toEqual(['ABCDEFGHIJ', 'KLMNOPQRST']);
    expect(target?.knowledgeBaseId).toBeUndefined();
  });

  it('rejects a second agentic-retrieve target on the same gateway', async () => {
    const initial = emptyProject();
    initial.agentCoreGateways[0]!.targets = [
      {
        name: 'main-gw-agentic',
        targetType: 'connector',
        connectorId: 'bedrock-agentic-retrieve',
        knowledgeBaseIds: ['existing'],
      } as unknown as AgentCoreProjectSpec['agentCoreGateways'][0]['targets'][0],
    ];
    const { primitive } = makePrimitive(initial);
    await expect(
      primitive.createConnectorGatewayTarget({
        targetType: 'connector',
        name: 'another-agentic',
        gateway: 'main-gw',
        connectorId: 'bedrock-agentic-retrieve',
        knowledgeBaseIds: ['ABCDEFGHIJ'],
      })
    ).rejects.toThrow(/already has a bedrock-agentic-retrieve target/);
  });
});

describe('GatewayTargetPrimitive — createWebSearchGatewayTarget', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes a webSearch target with no excludeDomains when omitted', async () => {
    const { primitive, getProject } = makePrimitive(emptyProject());
    const result = await primitive.createWebSearchGatewayTarget({
      targetType: 'webSearch',
      name: 'web-search',
      gateway: 'main-gw',
    });
    expect(result.toolName).toBe('web-search');
    const target = getProject().agentCoreGateways[0]?.targets[0];
    expect(target?.targetType).toBe('webSearch');
    expect(target?.name).toBe('web-search');
    expect(target?.excludeDomains).toBeUndefined();
  });

  it('persists excludeDomains when provided', async () => {
    const { primitive, getProject } = makePrimitive(emptyProject());
    await primitive.createWebSearchGatewayTarget({
      targetType: 'webSearch',
      name: 'ws',
      gateway: 'main-gw',
      excludeDomains: ['internal.example.com', 'staging.example.com'],
    });
    const target = getProject().agentCoreGateways[0]?.targets[0];
    expect(target?.excludeDomains).toEqual(['internal.example.com', 'staging.example.com']);
  });

  it('rejects a duplicate target name on the same gateway', async () => {
    const { primitive } = makePrimitive(emptyProject());
    await primitive.createWebSearchGatewayTarget({
      targetType: 'webSearch',
      name: 'ws',
      gateway: 'main-gw',
    });
    await expect(
      primitive.createWebSearchGatewayTarget({
        targetType: 'webSearch',
        name: 'ws',
        gateway: 'main-gw',
      })
    ).rejects.toThrow(/already exists/);
  });

  it('rejects a target attached to an unknown gateway', async () => {
    const { primitive } = makePrimitive(emptyProject());
    await expect(
      primitive.createWebSearchGatewayTarget({
        targetType: 'webSearch',
        name: 'ws',
        gateway: 'does-not-exist',
      })
    ).rejects.toThrow(/not found/);
  });
});
