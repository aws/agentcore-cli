import { getAgentRuntimeStatus } from '../agentcore-control.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSend } = vi.hoisted(() => ({
  mockSend: vi.fn(),
}));

vi.mock('@aws-sdk/client-bedrock-agentcore-control', () => ({
  BedrockAgentCoreControlClient: class {
    send = mockSend;
  },
  GetAgentRuntimeCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock('../account', () => ({
  getCredentialProvider: vi.fn().mockReturnValue({}),
}));

describe('getAgentRuntimeStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns runtime status', async () => {
    mockSend.mockResolvedValue({ status: 'ACTIVE' });

    const result = await getAgentRuntimeStatus({ region: 'us-east-1', runtimeId: 'rt-123' });
    expect(result.runtimeId).toBe('rt-123');
    expect(result.status).toBe('ACTIVE');
  });

  it('throws when no status returned', async () => {
    mockSend.mockResolvedValue({ status: undefined });

    await expect(getAgentRuntimeStatus({ region: 'us-east-1', runtimeId: 'rt-456' })).rejects.toThrow(
      'No status returned for runtime rt-456'
    );
  });

  it('passes correct runtimeId in command', async () => {
    mockSend.mockResolvedValue({ status: 'CREATING' });

    await getAgentRuntimeStatus({ region: 'us-west-2', runtimeId: 'rt-abc' });

    const command = mockSend.mock.calls[0]![0];
    expect(command.input.agentRuntimeId).toBe('rt-abc');
  });

  it('propagates SDK errors', async () => {
    mockSend.mockRejectedValue(new Error('Service unavailable'));

    await expect(getAgentRuntimeStatus({ region: 'us-east-1', runtimeId: 'rt-err' })).rejects.toThrow(
      'Service unavailable'
    );
  });
});
