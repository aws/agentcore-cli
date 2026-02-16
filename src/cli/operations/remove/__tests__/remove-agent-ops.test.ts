import { getRemovableAgents, previewRemoveAgent, removeAgent } from '../remove-agent.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
  agents: agentNames.map(name => ({ name, type: 'AgentCoreRuntime' })),
  memories: [],
  credentials: [],
});

describe('getRemovableAgents', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns agent names from project', async () => {
    mockReadProjectSpec.mockResolvedValue(makeProject(['Agent1', 'Agent2']));

    const result = await getRemovableAgents();

    expect(result).toEqual(['Agent1', 'Agent2']);
  });

  it('returns empty array on error', async () => {
    mockReadProjectSpec.mockRejectedValue(new Error('fail'));

    expect(await getRemovableAgents()).toEqual([]);
  });
});

describe('previewRemoveAgent', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns preview for existing agent', async () => {
    mockReadProjectSpec.mockResolvedValue(makeProject(['Agent1', 'Agent2']));

    const preview = await previewRemoveAgent('Agent1');

    expect(preview.summary).toContain('Removing agent: Agent1');
    expect(preview.schemaChanges).toHaveLength(1);
    expect(preview.schemaChanges[0]!.file).toBe('agentcore/agentcore.json');
  });

  it('throws when agent not found', async () => {
    mockReadProjectSpec.mockResolvedValue(makeProject(['Agent1']));

    await expect(previewRemoveAgent('NonExistent')).rejects.toThrow('Agent "NonExistent" not found');
  });
});

describe('removeAgent', () => {
  afterEach(() => vi.clearAllMocks());

  it('removes agent and writes spec', async () => {
    const project = makeProject(['Agent1', 'Agent2']);
    mockReadProjectSpec.mockResolvedValue(project);
    mockWriteProjectSpec.mockResolvedValue(undefined);

    const result = await removeAgent('Agent1');

    expect(result).toEqual({ ok: true });
    expect(mockWriteProjectSpec).toHaveBeenCalled();
    expect(project.agents).toHaveLength(1);
    expect(project.agents[0]!.name).toBe('Agent2');
  });

  it('returns error when agent not found', async () => {
    mockReadProjectSpec.mockResolvedValue(makeProject(['Agent1']));

    const result = await removeAgent('Missing');

    expect(result).toEqual({ ok: false, error: 'Agent "Missing" not found.' });
  });

  it('returns error on exception', async () => {
    mockReadProjectSpec.mockRejectedValue(new Error('read fail'));

    const result = await removeAgent('Agent1');

    expect(result).toEqual({ ok: false, error: 'read fail' });
  });
});
