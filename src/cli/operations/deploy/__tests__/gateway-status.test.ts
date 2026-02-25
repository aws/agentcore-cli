import { formatTargetStatus, getGatewayTargetStatuses } from '../gateway-status.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockSend } = vi.hoisted(() => ({
  mockSend: vi.fn(),
}));

vi.mock('@aws-sdk/client-bedrock-agentcore-control', () => ({
  BedrockAgentCoreControlClient: class {
    send = mockSend;
  },
  ListGatewayTargetsCommand: class {
    constructor(public input: unknown) {}
  },
}));

describe('getGatewayTargetStatuses', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns statuses for all targets', async () => {
    mockSend.mockResolvedValue({
      items: [
        { name: 'target-1', status: 'READY' },
        { name: 'target-2', status: 'SYNCHRONIZING' },
        { name: 'target-3', status: 'READY' },
      ],
    });

    const result = await getGatewayTargetStatuses('gw-123', 'us-east-1');

    expect(result).toEqual([
      { name: 'target-1', status: 'READY' },
      { name: 'target-2', status: 'SYNCHRONIZING' },
      { name: 'target-3', status: 'READY' },
    ]);
  });

  it('returns empty array on API error', async () => {
    mockSend.mockRejectedValue(new Error('Access denied'));

    const result = await getGatewayTargetStatuses('gw-123', 'us-east-1');

    expect(result).toEqual([]);
  });

  it('returns empty array when no targets', async () => {
    mockSend.mockResolvedValue({ items: [] });

    const result = await getGatewayTargetStatuses('gw-123', 'us-east-1');

    expect(result).toEqual([]);
  });

  it('handles undefined items', async () => {
    mockSend.mockResolvedValue({});

    const result = await getGatewayTargetStatuses('gw-123', 'us-east-1');

    expect(result).toEqual([]);
  });
});

describe('formatTargetStatus', () => {
  it('formats READY', () => {
    expect(formatTargetStatus('READY')).toBe('✓ synced');
  });

  it('formats SYNCHRONIZING', () => {
    expect(formatTargetStatus('SYNCHRONIZING')).toBe('⟳ syncing...');
  });

  it('formats SYNCHRONIZE_UNSUCCESSFUL', () => {
    expect(formatTargetStatus('SYNCHRONIZE_UNSUCCESSFUL')).toBe('⚠ sync failed');
  });

  it('formats FAILED', () => {
    expect(formatTargetStatus('FAILED')).toBe('✗ failed');
  });

  it('returns raw status for unknown values', () => {
    expect(formatTargetStatus('UNKNOWN_STATUS')).toBe('UNKNOWN_STATUS');
  });
});
