import { createConfigurationBundle, listConfigurationBundles } from '../agentcore-config-bundles.js';
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
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

describe('agentcore-config-bundles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createConfigurationBundle', () => {
    const components = {
      'arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/myRuntime-abc': {
        configuration: { systemPrompt: 'hi' },
      },
    };

    function parseRequestBody(): Record<string, unknown> {
      const init = mockFetch.mock.calls[0]![1] as { body: string };
      return JSON.parse(init.body) as Record<string, unknown>;
    }

    it('includes kmsKeyArn in the request body when provided', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({ bundleArn: 'arn', bundleId: 'id', versionId: 'v1', createdAt: '2026-01-01' })
      );
      const kmsKeyArn = 'arn:aws:kms:us-west-2:123456789012:key/12345678-1234-1234-1234-123456789012';

      await createConfigurationBundle({ region: 'us-west-2', bundleName: 'b', components, kmsKeyArn });

      expect(parseRequestBody().kmsKeyArn).toBe(kmsKeyArn);
    });

    it('omits kmsKeyArn from the request body when not provided', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({ bundleArn: 'arn', bundleId: 'id', versionId: 'v1', createdAt: '2026-01-01' })
      );

      await createConfigurationBundle({ region: 'us-west-2', bundleName: 'b', components });

      expect(parseRequestBody()).not.toHaveProperty('kmsKeyArn');
    });
  });

  describe('listConfigurationBundles', () => {
    it('returns bundles with createdAt timestamp', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({
          bundles: [
            {
              bundleArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:configuration-bundle/myBundle-abc123',
              bundleId: 'myBundle-abc123',
              bundleName: 'myBundle',
              createdAt: 1780442814.787,
            },
            {
              bundleArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:configuration-bundle/otherBundle-def456',
              bundleId: 'otherBundle-def456',
              bundleName: 'otherBundle',
              description: 'A test bundle',
              createdAt: 1780440000.0,
            },
          ],
        })
      );

      const result = await listConfigurationBundles({ region: 'us-west-2' });

      expect(result.bundles).toHaveLength(2);
      expect(result.bundles[0]!.bundleName).toBe('myBundle');
      expect(result.bundles[0]!.createdAt).toBe(1780442814.787);
      expect(result.bundles[1]!.createdAt).toBe(1780440000.0);
    });

    it('returns empty array when no bundles exist', async () => {
      mockFetch.mockResolvedValue(mockJsonResponse({ bundles: [] }));

      const result = await listConfigurationBundles({ region: 'us-west-2' });

      expect(result.bundles).toEqual([]);
    });
  });
});
