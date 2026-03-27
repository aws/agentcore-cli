import { CredentialPrimitive } from '../../../primitives/CredentialPrimitive.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock registry to break circular dependency: CredentialPrimitive → AddFlow → hooks → registry → primitives
vi.mock('../../../primitives/registry', () => ({
  credentialPrimitive: {},
  ALL_PRIMITIVES: [],
}));

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

const primitive = new CredentialPrimitive();

describe('getAllCredentialNames', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns credential names', async () => {
    mockReadProjectSpec.mockResolvedValue({
      credentials: [{ name: 'Cred1' }, { name: 'Cred2' }],
    });
    expect(await primitive.getAllNames()).toEqual(['Cred1', 'Cred2']);
  });

  it('returns empty on error', async () => {
    mockReadProjectSpec.mockRejectedValue(new Error('fail'));
    expect(await primitive.getAllNames()).toEqual([]);
  });
});

describe('createCredential', () => {
  afterEach(() => vi.clearAllMocks());

  it('creates new credential and writes to project', async () => {
    const project = { credentials: [] as any[] };
    mockReadProjectSpec.mockResolvedValue(project);
    mockWriteProjectSpec.mockResolvedValue(undefined);
    mockSetEnvVar.mockResolvedValue(undefined);

    const result = await primitive.add({
      authorizerType: 'ApiKeyCredentialProvider',
      name: 'NewCred',
      apiKey: 'key123',
    });

    expect(result).toEqual(expect.objectContaining({ success: true, credentialName: 'NewCred' }));
    expect(mockWriteProjectSpec).toHaveBeenCalled();
    expect(mockSetEnvVar).toHaveBeenCalledWith('AGENTCORE_CREDENTIAL_NEWCRED', 'key123');
  });

  it('reuses existing credential without writing project', async () => {
    const existing = { name: 'ExistCred', authorizerType: 'ApiKeyCredentialProvider' };
    mockReadProjectSpec.mockResolvedValue({ credentials: [existing] });
    mockSetEnvVar.mockResolvedValue(undefined);

    const result = await primitive.add({
      authorizerType: 'ApiKeyCredentialProvider',
      name: 'ExistCred',
      apiKey: 'newkey',
    });

    expect(result).toEqual(expect.objectContaining({ success: true, credentialName: 'ExistCred' }));
    expect(mockWriteProjectSpec).not.toHaveBeenCalled();
    expect(mockSetEnvVar).toHaveBeenCalledWith('AGENTCORE_CREDENTIAL_EXISTCRED', 'newkey');
  });
});

describe('resolveCredentialStrategy', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns no credential for Bedrock provider', async () => {
    const result = await primitive.resolveCredentialStrategy('Proj', 'Agent', 'Bedrock', 'key', '/base', []);
    expect(result.credentialName).toBe('');
    expect(result.reuse).toBe(true);
  });

  it('returns no credential when no API key', async () => {
    const result = await primitive.resolveCredentialStrategy(
      'Proj',
      'Agent',
      'Anthropic' as any,
      undefined,
      '/base',
      []
    );
    expect(result.credentialName).toBe('');
  });

  it('reuses existing credential with matching key', async () => {
    mockGetEnvVar.mockResolvedValue('my-api-key');
    const creds = [{ name: 'ProjAnthropic', authorizerType: 'ApiKeyCredentialProvider' as const }];

    const result = await primitive.resolveCredentialStrategy(
      'Proj',
      'Agent',
      'Anthropic' as any,
      'my-api-key',
      '/base',
      creds
    );

    expect(result.reuse).toBe(true);
    expect(result.credentialName).toBe('ProjAnthropic');
  });

  it('creates project-scoped credential when no existing', async () => {
    const result = await primitive.resolveCredentialStrategy(
      'Proj',
      'Agent',
      'Anthropic' as any,
      'new-key',
      '/base',
      []
    );

    expect(result.reuse).toBe(false);
    expect(result.credentialName).toBe('ProjAnthropic');
    expect(result.isAgentScoped).toBe(false);
  });

  it('creates agent-scoped credential when project-scoped exists with different key', async () => {
    mockGetEnvVar.mockResolvedValue('different-key');
    const creds = [{ name: 'ProjAnthropic', authorizerType: 'ApiKeyCredentialProvider' as const }];

    const result = await primitive.resolveCredentialStrategy(
      'Proj',
      'Agent',
      'Anthropic' as any,
      'new-key',
      '/base',
      creds
    );

    expect(result.reuse).toBe(false);
    expect(result.credentialName).toBe('ProjAgentAnthropic');
    expect(result.isAgentScoped).toBe(true);
  });
});

// TODO: OAuth credential creation needs to be added to CredentialPrimitive.
// These tests were ported from main's create-identity.ts OAuth support.
// Once CredentialPrimitive.addOAuth() is implemented, convert these to use primitive.addOAuth().
describe('createCredential OAuth', () => {
  afterEach(() => vi.clearAllMocks());

  it.todo('creates OAuth credential and writes to project');

  it.todo('writes CLIENT_ID and CLIENT_SECRET to env');

  it.todo('uppercases name in env var keys');

  it.todo('throws when OAuth credential already exists');

  it.todo('includes scopes when provided');
});
