import { getRemovableMemories, previewRemoveMemory, removeMemory } from '../remove-memory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockReadProjectSpec = vi.fn();
const mockWriteProjectSpec = vi.fn();

vi.mock('../../../../lib/index.js', () => ({
  ConfigIO: class {
    readProjectSpec = mockReadProjectSpec;
    writeProjectSpec = mockWriteProjectSpec;
  },
}));

const makeProject = (memoryNames: string[]) => ({
  name: 'TestProject',
  version: 1,
  agents: [],
  memories: memoryNames.map(name => ({ name, type: 'AgentCoreMemory', eventExpiryDuration: 30, strategies: [] })),
  credentials: [],
});

describe('getRemovableMemories', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns memory names from project', async () => {
    mockReadProjectSpec.mockResolvedValue(makeProject(['Mem1', 'Mem2']));

    const result = await getRemovableMemories();

    expect(result).toEqual([{ name: 'Mem1' }, { name: 'Mem2' }]);
  });

  it('returns empty array on error', async () => {
    mockReadProjectSpec.mockRejectedValue(new Error('fail'));

    expect(await getRemovableMemories()).toEqual([]);
  });
});

describe('previewRemoveMemory', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns preview for existing memory', async () => {
    mockReadProjectSpec.mockResolvedValue(makeProject(['Mem1']));

    const preview = await previewRemoveMemory('Mem1');

    expect(preview.summary).toContain('Removing memory: Mem1');
    expect(preview.schemaChanges).toHaveLength(1);
  });

  it('throws when memory not found', async () => {
    mockReadProjectSpec.mockResolvedValue(makeProject(['Mem1']));

    await expect(previewRemoveMemory('Missing')).rejects.toThrow('Memory "Missing" not found');
  });
});

describe('removeMemory', () => {
  afterEach(() => vi.clearAllMocks());

  it('removes memory and writes spec', async () => {
    const project = makeProject(['Mem1', 'Mem2']);
    mockReadProjectSpec.mockResolvedValue(project);
    mockWriteProjectSpec.mockResolvedValue(undefined);

    const result = await removeMemory('Mem1');

    expect(result).toEqual({ ok: true });
    expect(mockWriteProjectSpec).toHaveBeenCalled();
  });

  it('returns error when memory not found', async () => {
    mockReadProjectSpec.mockResolvedValue(makeProject([]));

    const result = await removeMemory('Missing');

    expect(result).toEqual({ ok: false, error: 'Memory "Missing" not found.' });
  });

  it('returns error on exception', async () => {
    mockReadProjectSpec.mockRejectedValue(new Error('read fail'));

    const result = await removeMemory('Mem1');

    expect(result).toEqual({ ok: false, error: 'read fail' });
  });
});
