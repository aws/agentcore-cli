import { detectAwsAccount } from '../aws-account.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSend } = vi.hoisted(() => ({
  mockSend: vi.fn(),
}));

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class {
    send = mockSend;
  },
  GetCallerIdentityCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock('@aws-sdk/credential-providers', () => ({
  fromNodeProviderChain: vi.fn().mockReturnValue({}),
}));

describe('detectAwsAccount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns account ID on success', async () => {
    mockSend.mockResolvedValue({ Account: '123456789012' });
    const result = await detectAwsAccount();
    expect(result).toBe('123456789012');
  });

  it('returns null when Account is undefined', async () => {
    mockSend.mockResolvedValue({});
    const result = await detectAwsAccount();
    expect(result).toBeNull();
  });

  it('returns null on error (no credentials)', async () => {
    mockSend.mockRejectedValue(new Error('Could not load credentials'));
    const result = await detectAwsAccount();
    expect(result).toBeNull();
  });
});
