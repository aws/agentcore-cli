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

    const result = await createCredential({ type: 'ApiKeyCredentialProvider', name: 'NewCred', apiKey: 'key123' });

    expect(result.name).toBe('NewCred');
    expect(result.type).toBe('ApiKeyCredentialProvider');
    expect(mockWriteProjectSpec).toHaveBeenCalled();
    expect(mockSetEnvVar).toHaveBeenCalledWith('AGENTCORE_CREDENTIAL_NEWCRED', 'key123');
  });

  it('reuses existing credential without writing project', async () => {
    const existing = { name: 'ExistCred', type: 'ApiKeyCredentialProvider' };
    mockReadProjectSpec.mockResolvedValue({ credentials: [existing] });
    mockSetEnvVar.mockResolvedValue(undefined);

    const result = await createCredential({ type: 'ApiKeyCredentialProvider', name: 'ExistCred', apiKey: 'newkey' });

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

describe('createCredential OAuth', () => {
  afterEach(() => vi.clearAllMocks());

  it('creates OAuth credential and writes to project', async () => {
    const project = { credentials: [] as any[] };
    mockReadProjectSpec.mockResolvedValue(project);
    mockWriteProjectSpec.mockResolvedValue(undefined);
    mockSetEnvVar.mockResolvedValue(undefined);

    const result = await createCredential({
      type: 'OAuthCredentialProvider',
      name: 'my-oauth',
      discoveryUrl: 'https://auth.example.com/.well-known/openid-configuration',
      clientId: 'client123',
      clientSecret: 'secret456',
    });

    expect(result.type).toBe('OAuthCredentialProvider');
    expect(result.name).toBe('my-oauth');
    expect(mockWriteProjectSpec).toHaveBeenCalled();
    const written = mockWriteProjectSpec.mock.calls[0]![0];
    expect(written.credentials[0]).toMatchObject({
      type: 'OAuthCredentialProvider',
      name: 'my-oauth',
      discoveryUrl: 'https://auth.example.com/.well-known/openid-configuration',
      vendor: 'CustomOauth2',
    });
  });

  it('writes CLIENT_ID and CLIENT_SECRET to env', async () => {
    mockReadProjectSpec.mockResolvedValue({ credentials: [] });
    mockWriteProjectSpec.mockResolvedValue(undefined);
    mockSetEnvVar.mockResolvedValue(undefined);

    await createCredential({
      type: 'OAuthCredentialProvider',
      name: 'my-oauth',
      discoveryUrl: 'https://example.com',
      clientId: 'cid',
      clientSecret: 'csec',
    });

    expect(mockSetEnvVar).toHaveBeenCalledWith('AGENTCORE_CREDENTIAL_MY_OAUTH_CLIENT_ID', 'cid');
    expect(mockSetEnvVar).toHaveBeenCalledWith('AGENTCORE_CREDENTIAL_MY_OAUTH_CLIENT_SECRET', 'csec');
  });

  it('uppercases name in env var keys', async () => {
    mockReadProjectSpec.mockResolvedValue({ credentials: [] });
    mockWriteProjectSpec.mockResolvedValue(undefined);
    mockSetEnvVar.mockResolvedValue(undefined);

    await createCredential({
      type: 'OAuthCredentialProvider',
      name: 'myOauth',
      discoveryUrl: 'https://example.com',
      clientId: 'cid',
      clientSecret: 'csec',
    });

    expect(mockSetEnvVar).toHaveBeenCalledWith('AGENTCORE_CREDENTIAL_MYOAUTH_CLIENT_ID', 'cid');
    expect(mockSetEnvVar).toHaveBeenCalledWith('AGENTCORE_CREDENTIAL_MYOAUTH_CLIENT_SECRET', 'csec');
  });

  it('throws when OAuth credential already exists', async () => {
    mockReadProjectSpec.mockResolvedValue({
      credentials: [{ name: 'existing', type: 'OAuthCredentialProvider' }],
    });

    await expect(
      createCredential({
        type: 'OAuthCredentialProvider',
        name: 'existing',
        discoveryUrl: 'https://example.com',
        clientId: 'cid',
        clientSecret: 'csec',
      })
    ).rejects.toThrow('Credential "existing" already exists');
  });

  it('includes scopes when provided', async () => {
    mockReadProjectSpec.mockResolvedValue({ credentials: [] });
    mockWriteProjectSpec.mockResolvedValue(undefined);
    mockSetEnvVar.mockResolvedValue(undefined);

    await createCredential({
      type: 'OAuthCredentialProvider',
      name: 'scoped',
      discoveryUrl: 'https://example.com',
      clientId: 'cid',
      clientSecret: 'csec',
      scopes: ['read', 'write'],
    });

    const written = mockWriteProjectSpec.mock.calls[0]![0];
    expect(written.credentials[0].scopes).toEqual(['read', 'write']);
  });
});
