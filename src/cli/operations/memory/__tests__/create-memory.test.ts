import { createMemory, getAllMemoryNames } from '../create-memory.js';
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
  memories: memoryNames.map(name => ({
    name,
    type: 'AgentCoreMemory',
    eventExpiryDuration: 30,
    strategies: [],
  })),
  credentials: [],
});

describe('getAllMemoryNames', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns memory names', async () => {
    mockReadProjectSpec.mockResolvedValue(makeProject(['Mem1', 'Mem2']));

    expect(await getAllMemoryNames()).toEqual(['Mem1', 'Mem2']);
  });

  it('returns empty array on error', async () => {
    mockReadProjectSpec.mockRejectedValue(new Error('fail'));

    expect(await getAllMemoryNames()).toEqual([]);
  });
});

describe('createMemory', () => {
  afterEach(() => vi.clearAllMocks());

  it('creates memory with strategies and default namespaces', async () => {
    const project = makeProject([]);
    mockReadProjectSpec.mockResolvedValue(project);
    mockWriteProjectSpec.mockResolvedValue(undefined);

    const result = await createMemory({
      name: 'NewMem',
      eventExpiryDuration: 60,
      strategies: [{ type: 'SEMANTIC' }],
    });

    expect(result.name).toBe('NewMem');
    expect(result.type).toBe('AgentCoreMemory');
    expect(result.eventExpiryDuration).toBe(60);
    expect(result.strategies[0]!.type).toBe('SEMANTIC');
    expect(result.strategies[0]!.namespaces).toEqual(['/users/{actorId}/facts']);
    expect(mockWriteProjectSpec).toHaveBeenCalled();
  });

  it('creates memory with strategy without default namespaces', async () => {
    const project = makeProject([]);
    mockReadProjectSpec.mockResolvedValue(project);
    mockWriteProjectSpec.mockResolvedValue(undefined);

    const result = await createMemory({
      name: 'NewMem',
      eventExpiryDuration: 30,
      strategies: [{ type: 'CUSTOM' }],
    });

    expect(result.strategies[0]!.namespaces).toBeUndefined();
  });

  it('throws on duplicate memory name', async () => {
    mockReadProjectSpec.mockResolvedValue(makeProject(['Existing']));

    await expect(createMemory({ name: 'Existing', eventExpiryDuration: 30, strategies: [] })).rejects.toThrow(
      'Memory "Existing" already exists'
    );
  });
});
