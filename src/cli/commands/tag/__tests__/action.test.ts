import { addTag, listTags, removeDefaultTag, removeTag, setDefaultTag } from '../action.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockReadProjectSpec, mockWriteProjectSpec, mockFindConfigRoot } = vi.hoisted(() => ({
  mockReadProjectSpec: vi.fn(),
  mockWriteProjectSpec: vi.fn(),
  mockFindConfigRoot: vi.fn(),
}));

vi.mock('../../../../lib/index.js', () => ({
  ConfigIO: class {
    readProjectSpec = mockReadProjectSpec;
    writeProjectSpec = mockWriteProjectSpec;
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
  runtimes: [
    {
      name: 'myAgent',
      build: 'CodeZip',
      entrypoint: 'main.py',
      codeLocation: 'app/myAgent',
      runtimeVersion: 'python3.13',
      protocol: 'HTTP',
    },
  ],
  memories: [{ name: 'myMemory', eventExpiryDuration: 30, strategies: [] }],
  credentials: [],
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
    expect(written.runtimes[0].tags).toEqual({ env: 'prod' });
  });

  it('adds tag to gateway and writes project spec', async () => {
    const result = await addTag('gateway:myGateway', 'env', 'prod');
    expect(result.success).toBe(true);
    expect(mockWriteProjectSpec).toHaveBeenCalledTimes(1);
    const written = mockWriteProjectSpec.mock.calls[0]![0];
    expect(written.agentCoreGateways[0].tags).toEqual({ env: 'prod' });
  });

  it('throws for invalid resource ref', async () => {
    await expect(addTag('invalid', 'key', 'value')).rejects.toThrow('Invalid resource reference');
  });

  it('throws for nonexistent resource', async () => {
    await expect(addTag('agent:noSuchAgent', 'key', 'value')).rejects.toThrow('not found');
  });

  it('rejects empty tag key', async () => {
    await expect(addTag('agent:myAgent', '', 'value')).rejects.toThrow('Invalid tag key');
  });

  it('rejects tag key exceeding 128 chars', async () => {
    await expect(addTag('agent:myAgent', 'k'.repeat(129), 'value')).rejects.toThrow('Invalid tag key');
  });

  it('rejects tag value exceeding 256 chars', async () => {
    await expect(addTag('agent:myAgent', 'key', 'v'.repeat(257))).rejects.toThrow('Invalid tag value');
  });

  it('rejects tag key with invalid characters', async () => {
    await expect(addTag('agent:myAgent', 'key\x00bad', 'value')).rejects.toThrow('Invalid tag key');
  });

  it('rejects tag value with invalid characters', async () => {
    await expect(addTag('agent:myAgent', 'key', 'value\x00bad')).rejects.toThrow('Invalid tag value');
  });

  it('rejects agentcore: prefixed keys', async () => {
    await expect(addTag('agent:myAgent', 'agentcore:custom', 'value')).rejects.toThrow('managed by the system');
  });
});

describe('removeTag', () => {
  it('removes tag from agent', async () => {
    const spec = baseSpec();
    (spec.runtimes[0] as Record<string, unknown>).tags = { env: 'prod', team: 'a' };
    mockReadProjectSpec.mockResolvedValue(spec);

    const result = await removeTag('agent:myAgent', 'env');
    expect(result.success).toBe(true);
    const written = mockWriteProjectSpec.mock.calls[0]![0];
    expect(written.runtimes[0].tags).toEqual({ team: 'a' });
  });

  it('throws when key not found with hint about defaults', async () => {
    await expect(removeTag('agent:myAgent', 'nonexistent')).rejects.toThrow('remove-defaults');
  });

  it('rejects agentcore: prefixed keys', async () => {
    await expect(removeTag('agent:myAgent', 'agentcore:created-by')).rejects.toThrow('managed by the system');
  });
});

describe('setDefaultTag', () => {
  it('sets project-level default tag', async () => {
    const result = await setDefaultTag('team', 'platform');
    expect(result.success).toBe(true);
    const written = mockWriteProjectSpec.mock.calls[0]![0];
    expect(written.tags).toEqual({ 'agentcore:created-by': 'agentcore-cli', team: 'platform' });
  });

  it('rejects agentcore: prefixed keys', async () => {
    await expect(setDefaultTag('agentcore:custom', 'value')).rejects.toThrow('managed by the system');
  });
});

describe('removeDefaultTag', () => {
  it('rejects removal of agentcore: prefixed system tags', async () => {
    await expect(removeDefaultTag('agentcore:created-by')).rejects.toThrow('managed by the system');
  });

  it('removes user-defined project-level default tag', async () => {
    const spec = baseSpec();
    (spec.tags as Record<string, string>).team = 'platform';
    mockReadProjectSpec.mockResolvedValue(spec);

    const result = await removeDefaultTag('team');
    expect(result.success).toBe(true);
    const written = mockWriteProjectSpec.mock.calls[0]![0];
    expect(written.tags).toEqual({ 'agentcore:created-by': 'agentcore-cli' });
  });

  it('throws when key not found', async () => {
    await expect(removeDefaultTag('nonexistent')).rejects.toThrow('not found');
  });
});
