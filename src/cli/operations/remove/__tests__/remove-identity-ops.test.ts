import {
  getRemovableCredentials,
  getRemovableIdentities,
  previewRemoveCredential,
  previewRemoveIdentity,
  removeCredential,
  removeIdentity,
} from '../remove-identity.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockReadProjectSpec = vi.fn();
const mockWriteProjectSpec = vi.fn();

vi.mock('../../../../lib/index.js', () => ({
  ConfigIO: class {
    readProjectSpec = mockReadProjectSpec;
    writeProjectSpec = mockWriteProjectSpec;
  },
}));

const makeProject = (credNames: string[]) => ({
  name: 'TestProject',
  version: 1,
  agents: [],
  memories: [],
  credentials: credNames.map(name => ({ name, type: 'ApiKeyCredentialProvider' })),
});

describe('getRemovableCredentials', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns credentials from project', async () => {
    mockReadProjectSpec.mockResolvedValue(makeProject(['Cred1', 'Cred2']));

    const result = await getRemovableCredentials();

    expect(result).toEqual([
      { name: 'Cred1', type: 'ApiKeyCredentialProvider' },
      { name: 'Cred2', type: 'ApiKeyCredentialProvider' },
    ]);
  });

  it('returns empty array on error', async () => {
    mockReadProjectSpec.mockRejectedValue(new Error('fail'));

    expect(await getRemovableCredentials()).toEqual([]);
  });
});

describe('previewRemoveCredential', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns preview with type and env note', async () => {
    mockReadProjectSpec.mockResolvedValue(makeProject(['MyCred']));

    const preview = await previewRemoveCredential('MyCred');

    expect(preview.summary).toContain('Removing credential: MyCred');
    expect(preview.summary).toContain('Type: ApiKeyCredentialProvider');
    expect(preview.summary).toContain('Note: .env file will not be modified');
  });

  it('throws when credential not found', async () => {
    mockReadProjectSpec.mockResolvedValue(makeProject([]));

    await expect(previewRemoveCredential('Missing')).rejects.toThrow('Credential "Missing" not found');
  });
});

describe('removeCredential', () => {
  afterEach(() => vi.clearAllMocks());

  it('removes credential and writes spec', async () => {
    const project = makeProject(['Cred1', 'Cred2']);
    mockReadProjectSpec.mockResolvedValue(project);
    mockWriteProjectSpec.mockResolvedValue(undefined);

    const result = await removeCredential('Cred1');

    expect(result).toEqual({ ok: true });
    expect(mockWriteProjectSpec).toHaveBeenCalled();
  });

  it('returns error when credential not found', async () => {
    mockReadProjectSpec.mockResolvedValue(makeProject([]));

    const result = await removeCredential('Missing');

    expect(result).toEqual({ ok: false, error: 'Credential "Missing" not found.' });
  });

  it('returns error on exception', async () => {
    mockReadProjectSpec.mockRejectedValue(new Error('read fail'));

    const result = await removeCredential('Cred1');

    expect(result).toEqual({ ok: false, error: 'read fail' });
  });
});

describe('aliases', () => {
  it('getRemovableIdentities is getRemovableCredentials', () => {
    expect(getRemovableIdentities).toBe(getRemovableCredentials);
  });

  it('previewRemoveIdentity is previewRemoveCredential', () => {
    expect(previewRemoveIdentity).toBe(previewRemoveCredential);
  });

  it('removeIdentity is removeCredential', () => {
    expect(removeIdentity).toBe(removeCredential);
  });
});
