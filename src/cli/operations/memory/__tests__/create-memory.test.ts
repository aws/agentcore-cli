import { MemoryPrimitive } from '../../../primitives/MemoryPrimitive.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock registry to break circular dependency: MemoryPrimitive → AddFlow → hooks → registry → primitives
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

const makeProject = (memoryNames: string[]) => ({
  name: 'TestProject',
  version: 1,
  managedBy: 'CDK' as const,
  agents: [],
  memories: memoryNames.map(name => ({
    name,

    eventExpiryDuration: 30,
    strategies: [],
  })),
  credentials: [],
});

const primitive = new MemoryPrimitive();

describe('getAllNames', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns memory names', async () => {
    mockReadProjectSpec.mockResolvedValue(makeProject(['Mem1', 'Mem2']));

    expect(await primitive.getAllNames()).toEqual(['Mem1', 'Mem2']);
  });

  it('returns empty array on error', async () => {
    mockReadProjectSpec.mockRejectedValue(new Error('fail'));

    expect(await primitive.getAllNames()).toEqual([]);
  });
});

describe('add', () => {
  afterEach(() => vi.clearAllMocks());

  it('creates memory with strategies and writes spec', async () => {
    const project = makeProject([]);
    mockReadProjectSpec.mockResolvedValue(project);
    mockWriteProjectSpec.mockResolvedValue(undefined);

    const result = await primitive.add({
      name: 'NewMem',
      strategies: 'SEMANTIC',
      expiry: 60,
    });

    expect(result).toEqual(expect.objectContaining({ success: true, memoryName: 'NewMem' }));
    expect(mockWriteProjectSpec).toHaveBeenCalled();

    // Verify the written spec contains the correct memory
    const writtenSpec = mockWriteProjectSpec.mock.calls[0]![0];
    const addedMemory = writtenSpec.memories.find((m: { name: string }) => m.name === 'NewMem');
    expect(addedMemory).toBeDefined();
    expect(addedMemory).toBeDefined();
    expect(addedMemory.eventExpiryDuration).toBe(60);
    expect(addedMemory.strategies[0]!.type).toBe('SEMANTIC');
    expect(addedMemory.strategies[0]!.namespaces).toEqual(['/users/{actorId}/facts']);
  });

  it('creates memory with strategy without default namespaces', async () => {
    const project = makeProject([]);
    mockReadProjectSpec.mockResolvedValue(project);
    mockWriteProjectSpec.mockResolvedValue(undefined);

    await primitive.add({
      name: 'NewMem',
      strategies: 'CUSTOM',
      expiry: 30,
    });

    const writtenSpec = mockWriteProjectSpec.mock.calls[0]![0];
    const addedMemory = writtenSpec.memories.find((m: { name: string }) => m.name === 'NewMem');
    expect(addedMemory.strategies[0]!.namespaces).toBeUndefined();
  });

  it('returns error on duplicate memory name', async () => {
    mockReadProjectSpec.mockResolvedValue(makeProject(['Existing']));

    const result = await primitive.add({ name: 'Existing', strategies: '', expiry: 30 });

    expect(result).toEqual(
      expect.objectContaining({ success: false, error: expect.stringContaining('Memory "Existing" already exists') })
    );
  });
});
