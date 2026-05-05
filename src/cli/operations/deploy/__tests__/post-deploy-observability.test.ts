import { setupTransactionSearch } from '../post-deploy-observability.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockEnableTransactionSearch, mockReadGlobalConfigSync } = vi.hoisted(() => ({
  mockEnableTransactionSearch: vi.fn(),
  mockReadGlobalConfigSync: vi.fn(),
}));

vi.mock('../../../aws/transaction-search', () => ({
  enableTransactionSearch: mockEnableTransactionSearch,
}));

vi.mock('../../../../lib/schemas/io/global-config', () => ({
  readGlobalConfigSync: mockReadGlobalConfigSync,
}));

describe('setupTransactionSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadGlobalConfigSync.mockReturnValue({});
    mockEnableTransactionSearch.mockResolvedValue({ success: true });
  });

  it('calls enableTransactionSearch with region, accountId, and default 100% indexing', async () => {
    const result = await setupTransactionSearch({
      region: 'us-west-2',
      accountId: '111222333444',
      agentNames: ['my-agent'],
    });

    expect(mockEnableTransactionSearch).toHaveBeenCalledWith('us-west-2', '111222333444', 100);
    expect(result).toEqual({ success: true });
  });

  it('passes custom transactionSearchIndexPercentage from config', async () => {
    mockReadGlobalConfigSync.mockReturnValue({ transactionSearchIndexPercentage: 25 });

    const result = await setupTransactionSearch({
      region: 'us-east-1',
      accountId: '123456789012',
      agentNames: ['agent-1'],
    });

    expect(mockEnableTransactionSearch).toHaveBeenCalledWith('us-east-1', '123456789012', 25);
    expect(result).toEqual({ success: true });
  });

  it('skips when agentNames is empty', async () => {
    const result = await setupTransactionSearch({
      region: 'us-east-1',
      accountId: '123456789012',
      agentNames: [],
    });

    expect(result).toEqual({ success: true });
    expect(mockEnableTransactionSearch).not.toHaveBeenCalled();
  });

  it('skips when disableTransactionSearch is true in config', async () => {
    mockReadGlobalConfigSync.mockReturnValue({ disableTransactionSearch: true });

    const result = await setupTransactionSearch({
      region: 'us-east-1',
      accountId: '123456789012',
      agentNames: ['agent-1'],
    });

    expect(result).toEqual({ success: true });
    expect(mockEnableTransactionSearch).not.toHaveBeenCalled();
  });

  it('propagates error from enableTransactionSearch', async () => {
    mockEnableTransactionSearch.mockResolvedValue({ success: false, error: new Error('Insufficient permissions') });

    const result = await setupTransactionSearch({
      region: 'us-east-1',
      accountId: '123456789012',
      agentNames: ['agent-1'],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBe('Insufficient permissions');
    }
  });

  it('triggers when hasGateways is true and agentNames is empty', async () => {
    const result = await setupTransactionSearch({
      region: 'us-west-2',
      accountId: '111222333444',
      agentNames: [],
      hasGateways: true,
    });
    expect(mockEnableTransactionSearch).toHaveBeenCalledWith('us-west-2', '111222333444', 100);
    expect(result).toEqual({ success: true });
  });

  it('skips when both agentNames empty and hasGateways false', async () => {
    const result = await setupTransactionSearch({
      region: 'us-east-1',
      accountId: '123456789012',
      agentNames: [],
      hasGateways: false,
    });
    expect(result).toEqual({ success: true });
    expect(mockEnableTransactionSearch).not.toHaveBeenCalled();
  });

  it('skips when agentNames empty and hasGateways undefined', async () => {
    const result = await setupTransactionSearch({
      region: 'us-east-1',
      accountId: '123456789012',
      agentNames: [],
    });
    expect(result).toEqual({ success: true });
    expect(mockEnableTransactionSearch).not.toHaveBeenCalled();
  });
});
