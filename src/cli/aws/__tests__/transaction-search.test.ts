import { enableTransactionSearch } from '../transaction-search.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockAppSignalsSend, mockLogsSend, mockXRaySend } = vi.hoisted(() => ({
  mockAppSignalsSend: vi.fn(),
  mockLogsSend: vi.fn(),
  mockXRaySend: vi.fn(),
}));

vi.mock('@aws-sdk/client-application-signals', () => ({
  ApplicationSignalsClient: class {
    send = mockAppSignalsSend;
  },
  StartDiscoveryCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock('@aws-sdk/client-cloudwatch-logs', () => ({
  CloudWatchLogsClient: class {
    send = mockLogsSend;
  },
  DescribeResourcePoliciesCommand: class {
    constructor(public input: unknown) {}
  },
  PutResourcePolicyCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock('@aws-sdk/client-xray', () => ({
  XRayClient: class {
    send = mockXRaySend;
  },
  GetTraceSegmentDestinationCommand: class {
    constructor(public input: unknown) {}
  },
  UpdateTraceSegmentDestinationCommand: class {
    constructor(public input: unknown) {}
  },
  UpdateIndexingRuleCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock('../account', () => ({
  getCredentialProvider: vi.fn().mockReturnValue({}),
}));

describe('enableTransactionSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function setupAllSuccess(options?: { destination?: string; hasPolicy?: boolean }) {
    mockAppSignalsSend.mockResolvedValue({});
    mockLogsSend.mockImplementation((cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'DescribeResourcePoliciesCommand') {
        return Promise.resolve({
          resourcePolicies: options?.hasPolicy ? [{ policyName: 'TransactionSearchXRayAccess' }] : [],
        });
      }
      return Promise.resolve({});
    });
    mockXRaySend.mockImplementation((cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'GetTraceSegmentDestinationCommand') {
        return Promise.resolve({ Destination: options?.destination ?? 'XRay' });
      }
      return Promise.resolve({});
    });
  }

  it('succeeds when all steps complete', async () => {
    setupAllSuccess();

    const result = await enableTransactionSearch('us-east-1', '123456789012');

    expect(result).toEqual({ success: true });
    expect(mockAppSignalsSend).toHaveBeenCalledOnce();
    expect(mockLogsSend).toHaveBeenCalled();
    expect(mockXRaySend).toHaveBeenCalled();
  });

  it('creates resource policy when it does not exist', async () => {
    setupAllSuccess({ hasPolicy: false });

    await enableTransactionSearch('us-east-1', '123456789012');

    // DescribeResourcePolicies + PutResourcePolicy
    expect(mockLogsSend).toHaveBeenCalledTimes(2);
    const putCmd = mockLogsSend.mock.calls[1]![0];
    expect(putCmd.input.policyName).toBe('TransactionSearchXRayAccess');
    const doc = JSON.parse(putCmd.input.policyDocument);
    expect(doc.Statement[0].Resource).toEqual([
      'arn:aws:logs:us-east-1:123456789012:log-group:aws/spans:*',
      'arn:aws:logs:us-east-1:123456789012:log-group:/aws/application-signals/data:*',
    ]);
  });

  it('skips resource policy creation when it already exists', async () => {
    setupAllSuccess({ hasPolicy: true });

    await enableTransactionSearch('us-east-1', '123456789012');

    // Only DescribeResourcePolicies, no PutResourcePolicy
    expect(mockLogsSend).toHaveBeenCalledOnce();
  });

  it('updates trace destination when not CloudWatchLogs', async () => {
    setupAllSuccess({ destination: 'XRay' });

    await enableTransactionSearch('us-east-1', '123456789012');

    expect(mockXRaySend).toHaveBeenCalledTimes(3);
    const updateCmd = mockXRaySend.mock.calls[1]![0];
    expect(updateCmd.input).toEqual({ Destination: 'CloudWatchLogs' });
  });

  it('skips trace destination update when already CloudWatchLogs', async () => {
    setupAllSuccess({ destination: 'CloudWatchLogs' });

    await enableTransactionSearch('us-east-1', '123456789012');

    expect(mockXRaySend).toHaveBeenCalledTimes(2);
    // First call is GetTraceSegmentDestination, second is UpdateIndexingRule (no update in between)
    const secondCmd = mockXRaySend.mock.calls[1]![0];
    expect(secondCmd.input).toEqual({
      Name: 'Default',
      Rule: { Probabilistic: { DesiredSamplingPercentage: 100 } },
    });
  });

  it('sets indexing to 100% on Default rule by default', async () => {
    setupAllSuccess();

    await enableTransactionSearch('us-east-1', '123456789012');

    const lastXRayCall = mockXRaySend.mock.calls[mockXRaySend.mock.calls.length - 1]![0];
    expect(lastXRayCall.input).toEqual({
      Name: 'Default',
      Rule: { Probabilistic: { DesiredSamplingPercentage: 100 } },
    });
  });

  it('sets indexing to custom percentage when provided', async () => {
    setupAllSuccess();

    await enableTransactionSearch('us-east-1', '123456789012', 50);

    const lastXRayCall = mockXRaySend.mock.calls[mockXRaySend.mock.calls.length - 1]![0];
    expect(lastXRayCall.input).toEqual({
      Name: 'Default',
      Rule: { Probabilistic: { DesiredSamplingPercentage: 50 } },
    });
  });

  describe('error handling', () => {
    it('returns error when Application Signals fails with AccessDeniedException', async () => {
      const error = new Error('Not authorized');
      error.name = 'AccessDeniedException';
      mockAppSignalsSend.mockRejectedValue(error);

      const result = await enableTransactionSearch('us-east-1', '123456789012');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Insufficient permissions to enable Application Signals');
    });

    it('returns error when Application Signals fails with generic error', async () => {
      mockAppSignalsSend.mockRejectedValue(new Error('Service unavailable'));

      const result = await enableTransactionSearch('us-east-1', '123456789012');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to enable Application Signals');
    });

    it('returns error when CloudWatch Logs policy fails with AccessDenied', async () => {
      mockAppSignalsSend.mockResolvedValue({});
      const error = new Error('Not authorized');
      error.name = 'AccessDenied';
      mockLogsSend.mockRejectedValue(error);

      const result = await enableTransactionSearch('us-east-1', '123456789012');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Insufficient permissions to configure CloudWatch Logs policy');
    });

    it('returns error when trace destination fails', async () => {
      mockAppSignalsSend.mockResolvedValue({});
      mockLogsSend.mockResolvedValue({ resourcePolicies: [] });
      mockXRaySend.mockRejectedValue(new Error('X-Ray error'));

      const result = await enableTransactionSearch('us-east-1', '123456789012');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to configure trace destination');
    });

    it('returns error when indexing rule update fails', async () => {
      mockAppSignalsSend.mockResolvedValue({});
      mockLogsSend.mockResolvedValue({ resourcePolicies: [] });
      let callCount = 0;
      mockXRaySend.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // GetTraceSegmentDestination succeeds
          return Promise.resolve({ Destination: 'CloudWatchLogs' });
        }
        // UpdateIndexingRule fails
        return Promise.reject(new Error('Indexing error'));
      });

      const result = await enableTransactionSearch('us-east-1', '123456789012');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to configure indexing rules');
    });

    it('does not proceed to later steps when an earlier step fails', async () => {
      mockAppSignalsSend.mockRejectedValue(new Error('fail'));

      await enableTransactionSearch('us-east-1', '123456789012');

      expect(mockLogsSend).not.toHaveBeenCalled();
      expect(mockXRaySend).not.toHaveBeenCalled();
    });
  });
});
