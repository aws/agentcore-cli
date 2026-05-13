import { ResourceNotFoundError } from '../../../../lib';
import { CredentialPrimitive } from '../../../primitives/CredentialPrimitive.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock registry to break circular dependency: CredentialPrimitive → AddFlow → hooks → registry → primitives
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
    configExists = vi.fn().mockReturnValue(false);
  },
  findConfigRoot: () => '/fake/root',
  toError: (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
  serializeResult: (r: unknown) => r,
  ResourceNotFoundError: class extends Error {
    constructor(m: string) {
      super(m);
      this.name = 'ResourceNotFoundError';
    }
  },
  ConflictError: class extends Error {
    constructor(m: string) {
      super(m);
      this.name = 'ConflictError';
    }
  },
  setEnvVar: vi.fn().mockResolvedValue(undefined),
  getEnvVar: vi.fn(),
}));

const makeProject = (
  credNames: string[],
  agentCoreGateways: { targets?: { outboundAuth?: { credentialName?: string } }[] }[] = []
) => ({
  name: 'TestProject',
  version: 1,
  managedBy: 'CDK' as const,
  runtimes: [],
  memories: [],
  credentials: credNames.map(name => ({ name, authorizerType: 'ApiKeyCredentialProvider' })),
  agentCoreGateways,
});

const primitive = new CredentialPrimitive();

describe('getRemovable', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns credentials from project', async () => {
    mockReadProjectSpec.mockResolvedValue(makeProject(['Cred1', 'Cred2']));

    const result = await primitive.getRemovable();

    expect(result).toEqual([
      { name: 'Cred1', authorizerType: 'ApiKeyCredentialProvider' },
      { name: 'Cred2', authorizerType: 'ApiKeyCredentialProvider' },
    ]);
  });

  it('returns empty array on error', async () => {
    mockReadProjectSpec.mockRejectedValue(new Error('fail'));

    expect(await primitive.getRemovable()).toEqual([]);
  });
});

describe('previewRemove', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns preview with type and env note', async () => {
    mockReadProjectSpec.mockResolvedValue(makeProject(['MyCred']));

    const preview = await primitive.previewRemove('MyCred');

    expect(preview.summary).toContain('Removing credential: MyCred');
    expect(preview.summary).toContain('Type: ApiKeyCredentialProvider');
    expect(preview.summary).toContain('Note: .env file will not be modified');
  });

  it('throws when credential not found', async () => {
    mockReadProjectSpec.mockResolvedValue(makeProject([]));

    await expect(primitive.previewRemove('Missing')).rejects.toThrow('Credential "Missing" not found');
  });
});

describe('remove', () => {
  afterEach(() => vi.clearAllMocks());

  it('removes credential and writes spec', async () => {
    const project = makeProject(['Cred1', 'Cred2']);
    mockReadProjectSpec.mockResolvedValue(project);
    mockWriteProjectSpec.mockResolvedValue(undefined);

    const result = await primitive.remove('Cred1');

    expect(result).toEqual({ success: true });
    expect(mockWriteProjectSpec).toHaveBeenCalled();
  });

  it('returns error when credential not found', async () => {
    mockReadProjectSpec.mockResolvedValue(makeProject([]));

    const result = await primitive.remove('Missing');

    expect(result).toEqual({ success: false, error: new ResourceNotFoundError('Credential "Missing" not found.') });
  });

  it('returns error on exception', async () => {
    mockReadProjectSpec.mockRejectedValue(new Error('read fail'));

    const result = await primitive.remove('Cred1');

    expect(result).toEqual({ success: false, error: new Error('read fail') });
  });
});
