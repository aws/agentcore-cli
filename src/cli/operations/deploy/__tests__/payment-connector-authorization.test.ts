import {
  formatQuickCreateConnectorAuthorization,
  getQuickCreateConnectorAuthorizations,
} from '../payment-connector-authorization';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockGetPaymentConnector } = vi.hoisted(() => ({
  mockGetPaymentConnector: vi.fn(),
}));

vi.mock('../../../aws/agentcore-payments', () => ({
  getPaymentConnector: mockGetPaymentConnector,
}));

const projectSpec = {
  name: 'TestProject',
  payments: [
    {
      name: 'PayMgr',
      authorizerType: 'AWS_IAM',
      connectors: [
        {
          name: 'Quick',
          provider: 'CoinbaseCDP',
          provisionMode: 'QUICK_CREATE',
        },
        {
          name: 'Manual',
          provider: 'CoinbaseCDP',
          credentialName: 'manual-credential',
        },
      ],
    },
  ],
  credentials: [],
  runtimes: [],
} as any;

const payments = {
  PayMgr: {
    managerId: 'manager-123',
    managerArn: 'arn:manager',
    connectors: {
      Quick: {
        connectorId: 'connector-123',
        provisionMode: 'QUICK_CREATE' as const,
      },
    },
    processPaymentRoleArn: 'arn:process-role',
    resourceRetrievalRoleArn: 'arn:retrieval-role',
  },
};

describe('getQuickCreateConnectorAuthorizations', () => {
  afterEach(() => vi.clearAllMocks());

  it('reads only Quick Create connectors using deployed identifiers', async () => {
    mockGetPaymentConnector.mockResolvedValue({
      paymentConnectorId: 'connector-123',
      name: 'Quick',
      type: 'CoinbaseCDP',
      credentialProviderConfigurations: [],
      createdAt: '2026-08-17T00:00:00Z',
      lastUpdatedAt: '2026-08-17T00:00:00Z',
      status: 'PENDING_AUTHENTICATION',
      authorizationUrl: 'https://example.com/authorize',
    });

    const result = await getQuickCreateConnectorAuthorizations({
      region: 'ap-southeast-2',
      projectSpec,
      payments,
    });

    expect(mockGetPaymentConnector).toHaveBeenCalledOnce();
    expect(mockGetPaymentConnector).toHaveBeenCalledWith({
      region: 'ap-southeast-2',
      paymentManagerId: 'manager-123',
      paymentConnectorId: 'connector-123',
    });
    expect(result).toEqual([
      {
        managerName: 'PayMgr',
        connectorName: 'Quick',
        connectorId: 'connector-123',
        status: 'PENDING_AUTHENTICATION',
        authorizationUrl: 'https://example.com/authorize',
      },
    ]);
  });

  it('keeps deployment successful when the live read fails', async () => {
    mockGetPaymentConnector.mockRejectedValue(new Error('network unavailable'));

    const [result] = await getQuickCreateConnectorAuthorizations({
      region: 'ap-southeast-2',
      projectSpec,
      payments,
    });

    expect(result?.error).toBe('network unavailable');
    expect(formatQuickCreateConnectorAuthorization(result!)).toContain('Run `agentcore status` to retry');
  });
});

describe('formatQuickCreateConnectorAuthorization', () => {
  it('prints the live URL only while pending', () => {
    expect(
      formatQuickCreateConnectorAuthorization({
        managerName: 'PayMgr',
        connectorName: 'Quick',
        status: 'PENDING_AUTHENTICATION',
        authorizationUrl: 'https://example.com/authorize',
      })
    ).toContain('https://example.com/authorize');
  });

  it('reports READY without an authorization URL', () => {
    const notice = formatQuickCreateConnectorAuthorization({
      managerName: 'PayMgr',
      connectorName: 'Quick',
      status: 'READY',
    });
    expect(notice).toContain('is ready');
    expect(notice).not.toContain('http');
  });

  it('requires connector recreation after authorization expires', () => {
    const notice = formatQuickCreateConnectorAuthorization({
      managerName: 'PayMgr',
      connectorName: 'Quick',
      status: 'AUTHENTICATION_EXPIRED',
    });
    expect(notice).toContain('Remove and deploy it, then add and deploy it again');
    expect(notice).not.toContain('Re-deploy it');
  });
});
