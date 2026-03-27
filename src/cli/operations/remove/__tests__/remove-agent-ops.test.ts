import { AgentPrimitive } from '../../../primitives/AgentPrimitive.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock registry to break circular dependency: AgentPrimitive → AddFlow → hooks → registry → AgentPrimitive
vi.mock('../../../primitives/registry', () => ({
  credentialPrimitive: {},
  ALL_PRIMITIVES: [],
}));

const mockReadProjectSpec = vi.fn();
const mockWriteProjectSpec = vi.fn();

vi.mock('../../../../lib/index.js', () => ({
  ConfigIO: class {
    readProjectSpec = mockReadProjectSpec;
    writeProjectSpec = mockWriteProjectSpec;
  },
}));

const makeProject = (agentNames: string[]) => ({
  name: 'TestProject',
  version: 1,
  managedBy: 'CDK' as const,
  agents: agentNames.map(name => ({ name })),
  memories: [],
  credentials: [],
});

const primitive = new AgentPrimitive();

describe('getRemovable', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns agent resources from project', async () => {
    mockReadProjectSpec.mockResolvedValue(makeProject(['Agent1', 'Agent2']));

    const result = await primitive.getRemovable();

    expect(result).toEqual([{ name: 'Agent1' }, { name: 'Agent2' }]);
  });

  it('returns empty array on error', async () => {
    mockReadProjectSpec.mockRejectedValue(new Error('fail'));

    expect(await primitive.getRemovable()).toEqual([]);
  });
});

describe('previewRemove', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns preview for existing agent', async () => {
    mockReadProjectSpec.mockResolvedValue(makeProject(['Agent1', 'Agent2']));

    const preview = await primitive.previewRemove('Agent1');

    expect(preview.summary).toContain('Removing agent: Agent1');
    expect(preview.schemaChanges).toHaveLength(1);
    expect(preview.schemaChanges[0]!.file).toBe('agentcore/agentcore.json');
  });

  it('throws when agent not found', async () => {
    mockReadProjectSpec.mockResolvedValue(makeProject(['Agent1']));

    await expect(primitive.previewRemove('NonExistent')).rejects.toThrow('Agent "NonExistent" not found');
  });
});

describe('remove', () => {
  afterEach(() => vi.clearAllMocks());

  it('removes agent and writes spec', async () => {
    const project = makeProject(['Agent1', 'Agent2']);
    mockReadProjectSpec.mockResolvedValue(project);
    mockWriteProjectSpec.mockResolvedValue(undefined);

    const result = await primitive.remove('Agent1');

    expect(result).toEqual({ success: true });
    expect(mockWriteProjectSpec).toHaveBeenCalled();
    expect(project.agents).toHaveLength(1);
    expect(project.agents[0]!.name).toBe('Agent2');
  });

  it('returns error when agent not found', async () => {
    mockReadProjectSpec.mockResolvedValue(makeProject(['Agent1']));

    const result = await primitive.remove('Missing');

    expect(result).toEqual({ success: false, error: 'Agent "Missing" not found.' });
  });

  it('returns error on exception', async () => {
    mockReadProjectSpec.mockRejectedValue(new Error('read fail'));

    const result = await primitive.remove('Agent1');

    expect(result).toEqual({ success: false, error: 'read fail' });
  });
});
