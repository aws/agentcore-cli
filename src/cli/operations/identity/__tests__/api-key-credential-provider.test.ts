import {
  apiKeyProviderExists,
  createApiKeyProvider,
  setTokenVaultKmsKey,
  updateApiKeyProvider,
} from '../api-key-credential-provider.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockSend, MockResourceNotFoundException } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  MockResourceNotFoundException: class extends Error {
    constructor(message = 'not found') {
      super(message);
      this.name = 'ResourceNotFoundException';
    }
  },
}));

vi.mock('@aws-sdk/client-bedrock-agentcore-control', () => ({
  BedrockAgentCoreControlClient: class {
    send = mockSend;
  },
  GetApiKeyCredentialProviderCommand: class {
    constructor(public input: unknown) {}
  },
  CreateApiKeyCredentialProviderCommand: class {
    constructor(public input: unknown) {}
  },
  UpdateApiKeyCredentialProviderCommand: class {
    constructor(public input: unknown) {}
  },
  SetTokenVaultCMKCommand: class {
    constructor(public input: unknown) {}
  },
  ResourceNotFoundException: MockResourceNotFoundException,
}));

// Create a mock client
function makeMockClient() {
  return { send: mockSend } as any;
}

describe('apiKeyProviderExists', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns true when provider exists', async () => {
    mockSend.mockResolvedValue({});

    expect(await apiKeyProviderExists(makeMockClient(), 'my-provider')).toBe(true);
  });

  it('returns false on ResourceNotFoundException', async () => {
    mockSend.mockRejectedValue(new MockResourceNotFoundException());

    expect(await apiKeyProviderExists(makeMockClient(), 'my-provider')).toBe(false);
  });

  it('rethrows other errors', async () => {
    mockSend.mockRejectedValue(new Error('other error'));

    await expect(apiKeyProviderExists(makeMockClient(), 'my-provider')).rejects.toThrow('other error');
  });
});

describe('createApiKeyProvider', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns success with credentialProviderArn', async () => {
    mockSend.mockResolvedValueOnce({}); // create
    mockSend.mockResolvedValueOnce({ credentialProviderArn: 'arn:aws:bedrock:us-east-1:123:provider/prov' }); // get

    const result = await createApiKeyProvider(makeMockClient(), 'prov', 'key123');

    expect(result).toEqual({
      success: true,
      credentialProviderArn: 'arn:aws:bedrock:us-east-1:123:provider/prov',
    });
  });

  it('returns success on ConflictException with ARN from get', async () => {
    const err = new Error('conflict');
    Object.defineProperty(err, 'name', { value: 'ConflictException' });
    mockSend.mockRejectedValueOnce(err);
    mockSend.mockResolvedValueOnce({ credentialProviderArn: 'arn:aws:bedrock:us-east-1:123:provider/prov' }); // get

    const result = await createApiKeyProvider(makeMockClient(), 'prov', 'key123');

    expect(result).toEqual({
      success: true,
      credentialProviderArn: 'arn:aws:bedrock:us-east-1:123:provider/prov',
    });
  });

  it('returns success on ResourceAlreadyExistsException with ARN from get', async () => {
    const err = new Error('exists');
    Object.defineProperty(err, 'name', { value: 'ResourceAlreadyExistsException' });
    mockSend.mockRejectedValueOnce(err);
    mockSend.mockResolvedValueOnce({ credentialProviderArn: 'arn:aws:bedrock:us-east-1:123:provider/prov' }); // get

    const result = await createApiKeyProvider(makeMockClient(), 'prov', 'key123');

    expect(result).toEqual({
      success: true,
      credentialProviderArn: 'arn:aws:bedrock:us-east-1:123:provider/prov',
    });
  });

  it('returns success without ARN when conflict get fails', async () => {
    const conflictErr = new Error('conflict');
    Object.defineProperty(conflictErr, 'name', { value: 'ConflictException' });
    mockSend.mockRejectedValueOnce(conflictErr);
    mockSend.mockRejectedValueOnce(new Error('get failed')); // get fails

    const result = await createApiKeyProvider(makeMockClient(), 'prov', 'key123');

    expect(result).toEqual({ success: true });
  });

  it('returns failure on other errors', async () => {
    mockSend.mockRejectedValue(new Error('unexpected'));

    const result = await createApiKeyProvider(makeMockClient(), 'prov', 'key123');

    expect(result.success).toBe(false);
    expect((result as { success: false; error: Error }).error.message).toBe('unexpected');
  });
});

describe('updateApiKeyProvider', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns success with credentialProviderArn', async () => {
    mockSend.mockResolvedValueOnce({}); // update
    mockSend.mockResolvedValueOnce({ credentialProviderArn: 'arn:aws:bedrock:us-east-1:123:provider/prov' }); // get

    const result = await updateApiKeyProvider(makeMockClient(), 'prov', 'newkey');

    expect(result).toEqual({
      success: true,
      credentialProviderArn: 'arn:aws:bedrock:us-east-1:123:provider/prov',
    });
  });

  it('returns failure on error', async () => {
    mockSend.mockRejectedValue(new Error('update fail'));

    const result = await updateApiKeyProvider(makeMockClient(), 'prov', 'newkey');

    expect(result.success).toBe(false);
    expect((result as { success: false; error: Error }).error.message).toBe('update fail');
  });
});

describe('setTokenVaultKmsKey', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns success', async () => {
    mockSend.mockResolvedValue({});

    expect(await setTokenVaultKmsKey(makeMockClient(), 'arn:aws:kms:key')).toEqual({ success: true });
  });

  it('returns failure on error', async () => {
    mockSend.mockRejectedValue(new Error('kms fail'));

    const result = await setTokenVaultKmsKey(makeMockClient(), 'arn:aws:kms:key');

    expect(result.success).toBe(false);
    expect((result as { success: false; error: Error }).error.message).toBe('kms fail');
  });
});
