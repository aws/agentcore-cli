import { addTag, listTags, removeDefaultTag, removeTag, setDefaultTag } from '../action.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockReadProjectSpec,
  mockWriteProjectSpec,
  mockReadMcpSpec,
  mockWriteMcpSpec,
  mockConfigExists,
  mockFindConfigRoot,
} = vi.hoisted(() => ({
  mockReadProjectSpec: vi.fn(),
  mockWriteProjectSpec: vi.fn(),
  mockReadMcpSpec: vi.fn(),
  mockWriteMcpSpec: vi.fn(),
  mockConfigExists: vi.fn(),
  mockFindConfigRoot: vi.fn(),
}));

vi.mock('../../../../lib/index.js', () => ({
  ConfigIO: class {
    readProjectSpec = mockReadProjectSpec;
    writeProjectSpec = mockWriteProjectSpec;
    readMcpSpec = mockReadMcpSpec;
    writeMcpSpec = mockWriteMcpSpec;
    configExists = mockConfigExists;
  },
  findConfigRoot: mockFindConfigRoot,
  NoProjectError: class NoProjectError extends Error {
    constructor() {
      super('No AgentCore project found');
      this.name = 'NoProjectError';
    }
  },
}));

const baseSpec = () => ({
  name: 'TestProject',
  version: 1,
  tags: { 'agentcore:created-by': 'agentcore-cli' },
  agents: [
    {
      type: 'AgentCoreRuntime',
      name: 'myAgent',
      build: 'CodeZip',
      entrypoint: 'main.py',
      codeLocation: 'app/myAgent',
      runtimeVersion: 'python3.13',
      protocol: 'HTTP',
    },
  ],
  memories: [{ type: 'AgentCoreMemory', name: 'myMemory', eventExpiryDuration: 30, strategies: [] }],
  credentials: [],
});

const baseMcpSpec = () => ({
  agentCoreGateways: [
    {
      name: 'myGateway',
      targets: [],
      authorizerType: 'NONE',
      enableSemanticSearch: true,
      exceptionLevel: 'NONE',
    },
  ],
});

beforeEach(() => {
  vi.clearAllMocks();
  mockFindConfigRoot.mockReturnValue('/fake/config/root');
  mockReadProjectSpec.mockResolvedValue(baseSpec());
  mockWriteProjectSpec.mockResolvedValue(undefined);
  mockReadMcpSpec.mockResolvedValue(baseMcpSpec());
  mockWriteMcpSpec.mockResolvedValue(undefined);
  mockConfigExists.mockReturnValue(true);
});

describe('listTags', () => {
  it('returns project defaults and all resources with merged tags', async () => {
    const result = await listTags();
    expect(result.projectDefaults).toEqual({ 'agentcore:created-by': 'agentcore-cli' });
    expect(result.resources).toHaveLength(3);
    expect(result.resources[0]).toEqual({
      type: 'agent',
      name: 'myAgent',
      tags: { 'agentcore:created-by': 'agentcore-cli' },
    });
  });

  it('filters by resource ref', async () => {
    const result = await listTags('agent:myAgent');
    expect(result.resources).toHaveLength(1);
    expect(result.resources[0]!.name).toBe('myAgent');
  });

  it('throws on nonexistent resource', async () => {
    await expect(listTags('agent:nonexistent')).rejects.toThrow('not found');
  });
});

describe('addTag', () => {
  it('adds tag to agent and writes spec', async () => {
    const result = await addTag('agent:myAgent', 'env', 'prod');
    expect(result.success).toBe(true);
    expect(mockWriteProjectSpec).toHaveBeenCalledTimes(1);
    const written = mockWriteProjectSpec.mock.calls[0]![0];
    expect(written.agents[0].tags).toEqual({ env: 'prod' });
  });

  it('adds tag to gateway and writes mcp spec', async () => {
    const result = await addTag('gateway:myGateway', 'env', 'prod');
    expect(result.success).toBe(true);
    expect(mockWriteMcpSpec).toHaveBeenCalledTimes(1);
    const written = mockWriteMcpSpec.mock.calls[0]![0];
    expect(written.agentCoreGateways[0].tags).toEqual({ env: 'prod' });
  });

  it('throws for invalid resource ref', async () => {
    await expect(addTag('invalid', 'key', 'value')).rejects.toThrow('Invalid resource reference');
  });

  it('throws for nonexistent resource', async () => {
    await expect(addTag('agent:noSuchAgent', 'key', 'value')).rejects.toThrow('not found');
  });
});

describe('removeTag', () => {
  it('removes tag from agent', async () => {
    const spec = baseSpec();
    (spec.agents[0] as Record<string, unknown>).tags = { env: 'prod', team: 'a' };
    mockReadProjectSpec.mockResolvedValue(spec);

    const result = await removeTag('agent:myAgent', 'env');
    expect(result.success).toBe(true);
    const written = mockWriteProjectSpec.mock.calls[0]![0];
    expect(written.agents[0].tags).toEqual({ team: 'a' });
  });

  it('throws when key not found', async () => {
    await expect(removeTag('agent:myAgent', 'nonexistent')).rejects.toThrow('Tag key');
  });
});

describe('setDefaultTag', () => {
  it('sets project-level default tag', async () => {
    const result = await setDefaultTag('team', 'platform');
    expect(result.success).toBe(true);
    const written = mockWriteProjectSpec.mock.calls[0]![0];
    expect(written.tags).toEqual({ 'agentcore:created-by': 'agentcore-cli', team: 'platform' });
  });
});

describe('removeDefaultTag', () => {
  it('removes project-level default tag', async () => {
    const result = await removeDefaultTag('agentcore:created-by');
    expect(result.success).toBe(true);
    const written = mockWriteProjectSpec.mock.calls[0]![0];
    expect(written.tags).toBeUndefined();
  });

  it('throws when key not found', async () => {
    await expect(removeDefaultTag('nonexistent')).rejects.toThrow('not found');
  });
});
