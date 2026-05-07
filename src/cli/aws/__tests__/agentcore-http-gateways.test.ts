import { createHttpGatewayTarget, getHttpGateway, listHttpGatewayTargets } from '../agentcore-http-gateways.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

vi.mock('../account', () => ({
  getCredentialProvider: vi.fn().mockReturnValue({
    accessKeyId: 'AKID',
    secretAccessKey: 'SECRET',
    sessionToken: 'TOKEN',
  }),
}));

vi.mock('@smithy/signature-v4', () => ({
  SignatureV4: class {
    // eslint-disable-next-line @typescript-eslint/require-await
    async sign(request: { headers: Record<string, string> }) {
      return { headers: { ...request.headers, Authorization: 'signed' } };
    }
  },
}));

vi.mock('@aws-crypto/sha256-js', () => ({
  Sha256: class {},
}));

vi.mock('@aws-sdk/credential-provider-node', () => ({
  defaultProvider: vi.fn(),
}));

function mockJsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map([['x-amzn-requestid', 'test-request-id']]),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

describe('agentcore-http-gateways', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createHttpGatewayTarget', () => {
    it('sends agentcoreRuntime in request body', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({
          targetId: 'tgt-001',
          name: 'my-target',
          status: 'CREATING',
        })
      );

      const result = await createHttpGatewayTarget({
        region: 'us-east-1',
        gatewayId: 'gw-123',
        targetName: 'my-target',
        runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/rt-1',
        qualifier: 'DEFAULT',
      });

      expect(result.targetId).toBe('tgt-001');
      expect(result.name).toBe('my-target');
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
      expect(body.name).toBe('my-target');
      expect(body.targetConfiguration.http.agentcoreRuntime).toEqual({
        arn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/rt-1',
        qualifier: 'DEFAULT',
      });
      expect(body.credentialProviderConfigurations).toEqual([{ credentialProviderType: 'GATEWAY_IAM_ROLE' }]);
      expect(body.clientToken).toBeDefined();
    });

    it('falls back to runtimeTargetConfiguration on ValidationException', async () => {
      // First call fails with ValidationException
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        headers: new Map([['x-amzn-requestid', 'test-request-id']]),
        text: () => Promise.resolve('ValidationException: Unknown field agentcoreRuntime'),
      });
      // Second call (fallback) succeeds
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          targetId: 'tgt-002',
          name: 'my-target',
          status: 'CREATING',
        })
      );

      const result = await createHttpGatewayTarget({
        region: 'us-east-1',
        gatewayId: 'gw-123',
        targetName: 'my-target',
        runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/rt-1',
      });

      expect(result.targetId).toBe('tgt-002');
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Second call should use runtimeTargetConfiguration
      const fallbackBody = JSON.parse(mockFetch.mock.calls[1]![1].body);
      expect(fallbackBody.targetConfiguration.http.runtimeTargetConfiguration).toEqual({
        arn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/rt-1',
        qualifier: 'DEFAULT',
      });
    });

    it('falls back to runtimeTargetConfiguration on 400 status', async () => {
      // First call fails with 400
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        headers: new Map([['x-amzn-requestid', 'test-request-id']]),
        text: () => Promise.resolve('400 Bad Request'),
      });
      // Second call (fallback) succeeds
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          targetId: 'tgt-003',
          name: 'my-target',
          status: 'CREATING',
        })
      );

      const result = await createHttpGatewayTarget({
        region: 'us-east-1',
        gatewayId: 'gw-123',
        targetName: 'my-target',
        runtimeArn: 'arn:runtime',
      });

      expect(result.targetId).toBe('tgt-003');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('throws on non-validation errors (no fallback)', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        headers: new Map([['x-amzn-requestid', 'test-request-id']]),
        text: () => Promise.resolve('Internal Server Error'),
      });

      await expect(
        createHttpGatewayTarget({
          region: 'us-east-1',
          gatewayId: 'gw-123',
          targetName: 'my-target',
          runtimeArn: 'arn:runtime',
        })
      ).rejects.toThrow('Failed to create target');

      // Only one call — no fallback attempt
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('getHttpGateway', () => {
    it('returns gateway details', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({
          gatewayId: 'gw-123',
          gatewayArn: 'arn:aws:bedrock-agentcore:us-east-1:123:gateway/gw-123',
          gatewayUrl: 'https://gw-123.example.com',
          name: 'my-gateway',
          status: 'READY',
          authorizerType: 'AWS_IAM',
          roleArn: 'arn:aws:iam::123:role/GwRole',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-02T00:00:00Z',
        })
      );

      const result = await getHttpGateway({ region: 'us-east-1', gatewayId: 'gw-123' });

      expect(result.gatewayId).toBe('gw-123');
      expect(result.name).toBe('my-gateway');
      expect(result.status).toBe('READY');
      expect(result.gatewayUrl).toBe('https://gw-123.example.com');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/gateways/gw-123'),
        expect.objectContaining({ method: 'GET' })
      );
    });
  });

  describe('listHttpGatewayTargets', () => {
    it('returns targets array', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({
          targets: [
            { targetId: 'tgt-1', name: 'target-1', status: 'READY' },
            { targetId: 'tgt-2', name: 'target-2', status: 'CREATING' },
          ],
        })
      );

      const result = await listHttpGatewayTargets({
        region: 'us-east-1',
        gatewayId: 'gw-123',
      });

      expect(result.targets).toHaveLength(2);
      expect(result.targets[0]!.targetId).toBe('tgt-1');
      expect(result.targets[0]!.name).toBe('target-1');
      expect(result.targets[1]!.targetId).toBe('tgt-2');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/gateways/gw-123/targets'),
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('handles response with items field instead of targets', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({
          items: [{ targetId: 'tgt-1', name: 'target-1', status: 'READY' }],
        })
      );

      const result = await listHttpGatewayTargets({
        region: 'us-east-1',
        gatewayId: 'gw-123',
      });

      expect(result.targets).toHaveLength(1);
      expect(result.targets[0]!.targetId).toBe('tgt-1');
    });
  });
});
