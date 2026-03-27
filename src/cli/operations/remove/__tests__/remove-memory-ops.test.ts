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
  memories: memoryNames.map(name => ({ name, type: 'AgentCoreMemory', eventExpiryDuration: 30, strategies: [] })),
  credentials: [],
});

const primitive = new MemoryPrimitive();

describe('getRemovable', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns memory resources from project', async () => {
    mockReadProjectSpec.mockResolvedValue(makeProject(['Mem1', 'Mem2']));

    const result = await primitive.getRemovable();

    expect(result).toEqual([{ name: 'Mem1' }, { name: 'Mem2' }]);
  });

  it('returns empty array on error', async () => {
    mockReadProjectSpec.mockRejectedValue(new Error('fail'));

    expect(await primitive.getRemovable()).toEqual([]);
  });
});

describe('previewRemove', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns preview for existing memory', async () => {
    mockReadProjectSpec.mockResolvedValue(makeProject(['Mem1']));

    const preview = await primitive.previewRemove('Mem1');

    expect(preview.summary).toContain('Removing memory: Mem1');
    expect(preview.schemaChanges).toHaveLength(1);
  });

  it('throws when memory not found', async () => {
    mockReadProjectSpec.mockResolvedValue(makeProject(['Mem1']));

    await expect(primitive.previewRemove('Missing')).rejects.toThrow('Memory "Missing" not found');
  });
});

describe('remove', () => {
  afterEach(() => vi.clearAllMocks());

  it('removes memory and writes spec', async () => {
    const project = makeProject(['Mem1', 'Mem2']);
    mockReadProjectSpec.mockResolvedValue(project);
    mockWriteProjectSpec.mockResolvedValue(undefined);

    const result = await primitive.remove('Mem1');

    expect(result).toEqual({ success: true });
    expect(mockWriteProjectSpec).toHaveBeenCalled();
  });

  it('returns error when memory not found', async () => {
    mockReadProjectSpec.mockResolvedValue(makeProject([]));

    const result = await primitive.remove('Missing');

    expect(result).toEqual({ success: false, error: 'Memory "Missing" not found.' });
  });

  it('returns error on exception', async () => {
    mockReadProjectSpec.mockRejectedValue(new Error('read fail'));

    const result = await primitive.remove('Mem1');

    expect(result).toEqual({ success: false, error: 'read fail' });
  });
});
