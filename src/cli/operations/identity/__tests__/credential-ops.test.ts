import { createCredential, getAllCredentialNames, resolveCredentialStrategy } from '../create-identity.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockReadProjectSpec = vi.fn();
const mockWriteProjectSpec = vi.fn();
const mockGetEnvVar = vi.fn();
const mockSetEnvVar = vi.fn();

vi.mock('../../../../lib', () => ({
  ConfigIO: class {
    readProjectSpec = mockReadProjectSpec;
    writeProjectSpec = mockWriteProjectSpec;
  },
  getEnvVar: (...args: unknown[]) => mockGetEnvVar(...args),
  setEnvVar: (...args: unknown[]) => mockSetEnvVar(...args),
}));

describe('getAllCredentialNames', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns credential names', async () => {
    mockReadProjectSpec.mockResolvedValue({
      credentials: [{ name: 'Cred1' }, { name: 'Cred2' }],
    });
    expect(await getAllCredentialNames()).toEqual(['Cred1', 'Cred2']);
  });

  it('returns empty on error', async () => {
    mockReadProjectSpec.mockRejectedValue(new Error('fail'));
    expect(await getAllCredentialNames()).toEqual([]);
  });
});

describe('createCredential', () => {
  afterEach(() => vi.clearAllMocks());

  it('creates new credential and writes to project', async () => {
    const project = { credentials: [] as any[] };
    mockReadProjectSpec.mockResolvedValue(project);
    mockWriteProjectSpec.mockResolvedValue(undefined);
    mockSetEnvVar.mockResolvedValue(undefined);

    const result = await createCredential({ name: 'NewCred', apiKey: 'key123' });

    expect(result.name).toBe('NewCred');
    expect(result.type).toBe('ApiKeyCredentialProvider');
    expect(mockWriteProjectSpec).toHaveBeenCalled();
    expect(mockSetEnvVar).toHaveBeenCalledWith('AGENTCORE_CREDENTIAL_NEWCRED', 'key123');
  });

  it('reuses existing credential without writing project', async () => {
    const existing = { name: 'ExistCred', type: 'ApiKeyCredentialProvider' };
    mockReadProjectSpec.mockResolvedValue({ credentials: [existing] });
    mockSetEnvVar.mockResolvedValue(undefined);

    const result = await createCredential({ name: 'ExistCred', apiKey: 'newkey' });

    expect(result).toBe(existing);
    expect(mockWriteProjectSpec).not.toHaveBeenCalled();
    expect(mockSetEnvVar).toHaveBeenCalledWith('AGENTCORE_CREDENTIAL_EXISTCRED', 'newkey');
  });
});

describe('resolveCredentialStrategy', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns no credential for Bedrock provider', async () => {
    const result = await resolveCredentialStrategy('Proj', 'Agent', 'Bedrock', 'key', '/base', []);
    expect(result.credentialName).toBe('');
    expect(result.reuse).toBe(true);
  });

  it('returns no credential when no API key', async () => {
    const result = await resolveCredentialStrategy('Proj', 'Agent', 'Anthropic' as any, undefined, '/base', []);
    expect(result.credentialName).toBe('');
  });

  it('reuses existing credential with matching key', async () => {
    mockGetEnvVar.mockResolvedValue('my-api-key');
    const creds = [{ name: 'ProjAnthropic', type: 'ApiKeyCredentialProvider' as const }];

    const result = await resolveCredentialStrategy('Proj', 'Agent', 'Anthropic' as any, 'my-api-key', '/base', creds);

    expect(result.reuse).toBe(true);
    expect(result.credentialName).toBe('ProjAnthropic');
  });

  it('creates project-scoped credential when no existing', async () => {
    const result = await resolveCredentialStrategy('Proj', 'Agent', 'Anthropic' as any, 'new-key', '/base', []);

    expect(result.reuse).toBe(false);
    expect(result.credentialName).toBe('ProjAnthropic');
    expect(result.isAgentScoped).toBe(false);
  });

  it('creates agent-scoped credential when project-scoped exists with different key', async () => {
    mockGetEnvVar.mockResolvedValue('different-key');
    const creds = [{ name: 'ProjAnthropic', type: 'ApiKeyCredentialProvider' as const }];

    const result = await resolveCredentialStrategy('Proj', 'Agent', 'Anthropic' as any, 'new-key', '/base', creds);

    expect(result.reuse).toBe(false);
    expect(result.credentialName).toBe('ProjAgentAnthropic');
    expect(result.isAgentScoped).toBe(true);
  });
});
