import type { AgentCoreProjectSpec } from '../../../schema';
import { GatewayTargetPrimitive } from '../GatewayTargetPrimitive';
import { Command } from '@commander-js/extra-typings';
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

  it('writes a connector target with configurations for bedrock-knowledge-bases', async () => {
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
    const retrieveConfig = (retrieve?.configurations ?? []).find(c => c.name === 'Retrieve');
    expect((retrieveConfig?.parameterValues as any)?.knowledgeBaseId).toBe('ABCDEFGHIJ');
  });

  it('bedrock-knowledge-bases creates target with both Retrieve and AgenticRetrieveStream configurations', async () => {
    const { primitive, getProject } = makePrimitive(emptyProject());
    await primitive.createConnectorGatewayTarget({
      targetType: 'connector',
      name: 'product-docs',
      gateway: 'main-gw',
      connectorId: 'bedrock-knowledge-bases',
      knowledgeBaseId: 'ABCDEFGHIJ',
    });
    const targets = getProject().agentCoreGateways[0]?.targets ?? [];
    expect(targets).toHaveLength(1);
    const target = targets.find(t => t.connectorId === 'bedrock-knowledge-bases');
    expect(target?.name).toBe('product-docs');
    const retrieveConfig = (target?.configurations ?? []).find(c => c.name === 'Retrieve');
    expect((retrieveConfig?.parameterValues as any)?.knowledgeBaseId).toBe('ABCDEFGHIJ');
    const agenticConfig = (target?.configurations ?? []).find(c => c.name === 'AgenticRetrieveStream');
    expect(agenticConfig).toBeDefined();
    const retrievers = (agenticConfig?.parameterValues as any)?.retrievers as any[];
    expect(retrievers?.map((r: any) => r.configuration.knowledgeBase.knowledgeBaseId)).toEqual(['ABCDEFGHIJ']);
  });

  it('two bedrock-knowledge-bases creates produce two separate targets each with their own configurations', async () => {
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
    expect(targets).toHaveLength(2);
    const targetA = targets.find(t => t.name === 'docs-a');
    const targetB = targets.find(t => t.name === 'docs-b');
    const agenticA = (targetA?.configurations ?? []).find(c => c.name === 'AgenticRetrieveStream');
    const agenticB = (targetB?.configurations ?? []).find(c => c.name === 'AgenticRetrieveStream');
    expect((agenticA?.parameterValues as any)?.retrievers?.[0]?.configuration?.knowledgeBase?.knowledgeBaseId).toBe(
      'ABCDEFGHIJ'
    );
    expect((agenticB?.parameterValues as any)?.retrievers?.[0]?.configuration?.knowledgeBase?.knowledgeBaseId).toBe(
      'KLMNOPQRST'
    );
  });

  it('rejects a duplicate target name on the same gateway', async () => {
    const { primitive } = makePrimitive(emptyProject());
    await primitive.createConnectorGatewayTarget({
      targetType: 'connector',
      name: 'product-docs',
      gateway: 'main-gw',
      connectorId: 'bedrock-knowledge-bases',
      knowledgeBaseId: 'ABCDEFGHIJ',
    });
    await expect(
      primitive.createConnectorGatewayTarget({
        targetType: 'connector',
        name: 'product-docs',
        gateway: 'main-gw',
        connectorId: 'bedrock-knowledge-bases',
        knowledgeBaseId: 'KLMNOPQRST',
      })
    ).rejects.toThrow(/already exists/);
  });
});

describe('GatewayTargetPrimitive — createWebSearchGatewayTarget', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes a connector target with connectorId web-search when excludeDomains omitted', async () => {
    const { primitive, getProject } = makePrimitive(emptyProject());
    const result = await primitive.createWebSearchGatewayTarget({
      targetType: 'webSearch',
      name: 'web-search',
      gateway: 'main-gw',
    });
    expect(result.toolName).toBe('web-search');
    const target = getProject().agentCoreGateways[0]?.targets[0];
    expect(target?.targetType).toBe('connector');
    expect(target?.connectorId).toBe('web-search');
    expect(target?.name).toBe('web-search');
    const wsConfig = (target?.configurations ?? []).find(c => c.name === 'WebSearch');
    expect(wsConfig).toBeDefined();
    expect(wsConfig?.parameterValues).toEqual({});
  });

  it('persists excludeDomains in configurations when provided', async () => {
    const { primitive, getProject } = makePrimitive(emptyProject());
    await primitive.createWebSearchGatewayTarget({
      targetType: 'webSearch',
      name: 'ws',
      gateway: 'main-gw',
      excludeDomains: ['internal.example.com', 'staging.example.com'],
    });
    const target = getProject().agentCoreGateways[0]?.targets[0];
    const wsConfig = (target?.configurations ?? []).find(c => c.name === 'WebSearch');
    expect((wsConfig?.parameterValues as any)?.domainFilter?.exclude).toEqual([
      'internal.example.com',
      'staging.example.com',
    ]);
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

// Regression guard for V2304968218: --help must not advertise api-key outbound
// auth for target types the validator rejects (mcp-server, passthrough). The
// help text is hand-written; this keeps it in step with TARGET_TYPE_AUTH_CONFIG.
describe('GatewayTargetPrimitive — add gateway-target --help outbound auth', () => {
  function renderHelp(): string {
    const add = new Command('add');
    const remove = new Command('remove');
    new GatewayTargetPrimitive().registerCommands(add, remove);
    const target = add.commands.find(c => c.name() === 'gateway-target');
    if (!target) throw new Error('gateway-target command not registered');
    // addHelpText('after', ...) is emitted by outputHelp(), not helpInformation().
    let out = '';
    target.configureOutput({ writeOut: (s: string) => (out += s) });
    target.outputHelp();
    return out;
  }

  it('does not offer api-key for mcp-server or passthrough', () => {
    const help = renderHelp();
    expect(help).toMatch(/mcp-server\s+oauth or none/);
    expect(help).toMatch(/passthrough\s+gateway-iam-role, oauth, or jwt-passthrough/);
    // api-key stays only where the validator accepts it.
    expect(help).toMatch(/open-api-schema\s+oauth or api-key/);
    expect(help).toMatch(/api-gateway\s+api-key or none/);
  });
});
