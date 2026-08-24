import { getPaymentConnector } from '../agentcore-payments';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSign, mockFetch } = vi.hoisted(() => ({
  mockSign: vi.fn(request => Promise.resolve(request)),
  mockFetch: vi.fn(),
}));

vi.mock('../account', () => ({
  getCredentialProvider: () => () =>
    Promise.resolve({
      accessKeyId: 'test',
      secretAccessKey: 'test',
    }),
}));

vi.mock('../stage-endpoint', () => ({
  controlPlaneEndpoint: (region: string) => `https://bedrock-agentcore-control.${region}.amazonaws.com`,
  dataPlaneEndpoint: (region: string) => `https://bedrock-agentcore.${region}.amazonaws.com`,
}));

vi.mock('@smithy/signature-v4', () => ({
  SignatureV4: class {
    sign = mockSign;
  },
}));

describe('getPaymentConnector', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('uses the GetPaymentConnector REST path and returns live authorization state', async () => {
    const response = {
      paymentConnectorId: 'connector-123',
      name: 'Quick',
      type: 'CoinbaseCDP',
      credentialProviderConfigurations: [],
      createdAt: '2026-08-17T00:00:00Z',
      lastUpdatedAt: '2026-08-17T00:00:00Z',
      status: 'PENDING_AUTHENTICATION',
      authorizationUrl: 'https://example.com/authorize',
    };
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(response),
    });

    await expect(
      getPaymentConnector({
        region: 'ap-southeast-2',
        paymentManagerId: 'manager/123',
        paymentConnectorId: 'connector 123',
      })
    ).resolves.toEqual(response);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://bedrock-agentcore-control.ap-southeast-2.amazonaws.com/payments/managers/manager%2F123/connectors/connector%20123',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('returns null for a missing connector', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve(JSON.stringify({ code: 'ResourceNotFoundException', message: 'not found' })),
    });

    await expect(
      getPaymentConnector({
        region: 'ap-southeast-2',
        paymentManagerId: 'manager-123',
        paymentConnectorId: 'missing',
      })
    ).resolves.toBeNull();
  });
});
