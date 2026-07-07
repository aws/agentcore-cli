import { AgentCoreApiClient, AgentCoreApiError } from '../api-client.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSign } = vi.hoisted(() => ({
  mockSign: vi.fn(),
}));

vi.mock('../account', () => ({
  getCredentialProvider: vi.fn().mockReturnValue({}),
}));

vi.mock('@smithy/signature-v4', () => ({
  SignatureV4: class {
    sign = mockSign;
  },
}));

vi.mock('@smithy/protocol-http', () => ({
  HttpRequest: class {
    constructor(public opts: unknown) {}
  },
}));

vi.mock('@aws-crypto/sha256-js', () => ({
  Sha256: class {},
}));

vi.mock('@aws-sdk/credential-provider-node', () => ({
  defaultProvider: vi.fn().mockReturnValue({}),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('AgentCoreApiClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AGENTCORE_STAGE;
    mockSign.mockResolvedValue({ headers: { host: 'example.com', 'content-type': 'application/json' } });
  });

  describe('endpoint resolution', () => {
    it('uses control plane prod endpoint by default', async () => {
      const client = new AgentCoreApiClient({ region: 'us-west-2', plane: 'control' });
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      await client.request({ method: 'GET', path: '/test' });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('bedrock-agentcore-control.us-west-2.amazonaws.com'),
        expect.anything()
      );
    });

    it('uses data plane prod endpoint', async () => {
      const client = new AgentCoreApiClient({ region: 'us-east-1', plane: 'data' });
      mockFetch.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

      await client.request({ method: 'GET', path: '/test' });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('bedrock-agentcore.us-east-1.amazonaws.com'),
        expect.anything()
      );
    });

    it('uses beta control plane endpoint when AGENTCORE_STAGE=beta', async () => {
      process.env.AGENTCORE_STAGE = 'beta';
      const client = new AgentCoreApiClient({ region: 'us-west-2', plane: 'control' });
      mockFetch.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

      await client.request({ method: 'GET', path: '/test' });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('beta.us-west-2.elcapcp.genesis-primitives.aws.dev'),
        expect.anything()
      );
    });

    it('uses gamma data plane endpoint when AGENTCORE_STAGE=gamma', async () => {
      process.env.AGENTCORE_STAGE = 'gamma';
      const client = new AgentCoreApiClient({ region: 'us-west-2', plane: 'data' });
      mockFetch.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

      await client.request({ method: 'GET', path: '/test' });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('gamma.us-west-2.elcapdp.genesis-primitives.aws.dev'),
        expect.anything()
      );
    });
  });

  describe('request()', () => {
    it('returns parsed JSON on success', async () => {
      const client = new AgentCoreApiClient({ region: 'us-west-2', plane: 'control' });
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ harnessId: 'h-123' }), { status: 200 }));

      const result = await client.request({ method: 'GET', path: '/harnesses/h-123' });

      expect(result).toEqual({ harnessId: 'h-123' });
    });

    it('returns empty object on 204', async () => {
      const client = new AgentCoreApiClient({ region: 'us-west-2', plane: 'control' });
      mockFetch.mockResolvedValue(new Response(null, { status: 204 }));

      const result = await client.request({ method: 'DELETE', path: '/harnesses/h-123' });

      expect(result).toEqual({});
    });

    it('throws AgentCoreApiError on non-2xx', async () => {
      const client = new AgentCoreApiClient({ region: 'us-west-2', plane: 'control' });
      mockFetch.mockResolvedValue(
        new Response('{"message":"Not found"}', {
          status: 404,
          headers: { 'x-amzn-requestid': 'req-abc' },
        })
      );

      const err = await client.request({ method: 'GET', path: '/harnesses/bad' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AgentCoreApiError);
      const apiErr = err as AgentCoreApiError;
      expect(apiErr.statusCode).toBe(404);
      expect(apiErr.requestId).toBe('req-abc');
      expect(apiErr.errorBody).toContain('Not found');
    });

    it('sends JSON body when provided', async () => {
      const client = new AgentCoreApiClient({ region: 'us-west-2', plane: 'control' });
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 201 }));

      await client.request({ method: 'POST', path: '/harnesses', body: { harnessName: 'test' } });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ body: JSON.stringify({ harnessName: 'test' }) })
      );
    });

    it('appends query parameters to URL', async () => {
      const client = new AgentCoreApiClient({ region: 'us-west-2', plane: 'control' });
      mockFetch.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

      await client.request({ method: 'GET', path: '/harnesses', query: { maxResults: '10' } });

      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('maxResults=10'), expect.anything());
    });
  });

  describe('requestRaw()', () => {
    it('returns raw Response object', async () => {
      const client = new AgentCoreApiClient({ region: 'us-west-2', plane: 'data' });
      const mockResponse = new Response('streaming data', { status: 200 });
      mockFetch.mockResolvedValue(mockResponse);

      const response = await client.requestRaw({ method: 'POST', path: '/harnesses/invoke' });

      expect(response).toBe(mockResponse);
      expect(response.status).toBe(200);
    });

    it('passes custom headers through', async () => {
      const client = new AgentCoreApiClient({ region: 'us-west-2', plane: 'data' });
      mockFetch.mockResolvedValue(new Response('', { status: 200 }));

      await client.requestRaw({
        method: 'POST',
        path: '/harnesses/invoke',
        headers: { 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': 'sess-123' },
      });

      expect(mockSign).toHaveBeenCalledWith(
        expect.objectContaining({
          opts: expect.objectContaining({
            headers: expect.objectContaining({
              'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': 'sess-123',
            }),
          }),
        })
      );
    });
  });
});
