import { setupTransactionSearch } from '../post-deploy-observability.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockEnableTransactionSearch, mockReadCliConfig } = vi.hoisted(() => ({
  mockEnableTransactionSearch: vi.fn(),
  mockReadCliConfig: vi.fn(),
}));

vi.mock('../../../aws/transaction-search', () => ({
  enableTransactionSearch: mockEnableTransactionSearch,
}));

vi.mock('../../../../lib/schemas/io/cli-config', () => ({
  readCliConfig: mockReadCliConfig,
}));

describe('setupTransactionSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadCliConfig.mockReturnValue({});
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
    mockReadCliConfig.mockReturnValue({ transactionSearchIndexPercentage: 25 });

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
    mockReadCliConfig.mockReturnValue({ disableTransactionSearch: true });

    const result = await setupTransactionSearch({
      region: 'us-east-1',
      accountId: '123456789012',
      agentNames: ['agent-1'],
    });

    expect(result).toEqual({ success: true });
    expect(mockEnableTransactionSearch).not.toHaveBeenCalled();
  });

  it('propagates error from enableTransactionSearch', async () => {
    mockEnableTransactionSearch.mockResolvedValue({ success: false, error: 'Insufficient permissions' });

    const result = await setupTransactionSearch({
      region: 'us-east-1',
      accountId: '123456789012',
      agentNames: ['agent-1'],
    });

    expect(result).toEqual({ success: false, error: 'Insufficient permissions' });
  });
});
