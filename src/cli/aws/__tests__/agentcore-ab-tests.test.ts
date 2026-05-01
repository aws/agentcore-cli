import { createABTest, deleteABTest, getABTest, listABTests, updateABTest } from '../agentcore-ab-tests.js';
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

describe('agentcore-ab-tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createABTest', () => {
    it('sends POST to /ab-tests with correct body', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({
          abTestId: 'abt-001',
          abTestArn: 'arn:abt:001',
          name: 'MyTest',
          status: 'CREATED',
          executionStatus: 'STOPPED',
          createdAt: '2026-01-01T00:00:00Z',
        })
      );

      const result = await createABTest({
        region: 'us-east-1',
        name: 'MyTest',
        gatewayArn: 'arn:aws:bedrock-agentcore:us-east-1:123:gateway/gw-1',
        roleArn: 'arn:aws:iam::123:role/TestRole',
        variants: [
          {
            name: 'C',
            weight: 80,
            variantConfiguration: { configurationBundle: { bundleArn: 'arn:bundle:c', bundleVersion: 'v1' } },
          },
          {
            name: 'T1',
            weight: 20,
            variantConfiguration: { configurationBundle: { bundleArn: 'arn:bundle:t', bundleVersion: 'v1' } },
          },
        ],
        evaluationConfig: { onlineEvaluationConfigArn: 'arn:eval:config' },
      });

      expect(result.abTestId).toBe('abt-001');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/ab-tests'),
        expect.objectContaining({ method: 'POST' })
      );

      const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
      expect(body.name).toBe('MyTest');
      expect(body.gatewayArn).toBe('arn:aws:bedrock-agentcore:us-east-1:123:gateway/gw-1');
      expect(body.variants).toHaveLength(2);
      expect(body.clientToken).toBeDefined();
    });

    it('omits optional fields when not provided', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({
          abTestId: 'abt-002',
          abTestArn: 'arn:abt:002',
          status: 'CREATED',
          executionStatus: 'STOPPED',
          createdAt: '2026-01-01T00:00:00Z',
        })
      );

      await createABTest({
        region: 'us-east-1',
        name: 'Test',
        gatewayArn: 'arn:gw',
        roleArn: 'arn:role',
        variants: [],
        evaluationConfig: { onlineEvaluationConfigArn: 'arn:eval' },
      });

      const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
      expect(body.description).toBeUndefined();
      expect(body.trafficAllocationConfig).toBeUndefined();
      expect(body.maxDurationDays).toBeUndefined();
      expect(body.enableOnCreate).toBeUndefined();
    });

    it('includes optional fields when provided', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({
          abTestId: 'abt-003',
          abTestArn: 'arn:abt:003',
          status: 'CREATED',
          executionStatus: 'RUNNING',
          createdAt: '2026-01-01T00:00:00Z',
        })
      );

      await createABTest({
        region: 'us-east-1',
        name: 'Test',
        description: 'A description',
        gatewayArn: 'arn:gw',
        roleArn: 'arn:role',
        variants: [],
        evaluationConfig: { onlineEvaluationConfigArn: 'arn:eval' },
        trafficAllocationConfig: { routeOnHeader: { headerName: 'X-AB' } },
        maxDurationDays: 30,
        enableOnCreate: true,
      });

      const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
      expect(body.description).toBe('A description');
      expect(body.trafficAllocationConfig).toEqual({ routeOnHeader: { headerName: 'X-AB' } });
      expect(body.maxDurationDays).toBe(30);
      expect(body.enableOnCreate).toBe(true);
    });

    it('throws on non-ok response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        headers: new Map([['x-amzn-requestid', 'test-request-id']]),
        text: () => Promise.resolve('Bad Request'),
      });

      await expect(
        createABTest({
          region: 'us-east-1',
          name: 'Test',
          gatewayArn: 'arn:gw',
          roleArn: 'arn:role',
          variants: [],
          evaluationConfig: { onlineEvaluationConfigArn: 'arn:eval' },
        })
      ).rejects.toThrow('ABTest API error (400)');
    });
  });

  describe('getABTest', () => {
    it('sends GET to /ab-tests/{id}', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({
          abTestId: 'abt-123',
          abTestArn: 'arn:abt:123',
          name: 'MyTest',
          status: 'ACTIVE',
          executionStatus: 'RUNNING',
          gatewayArn: 'arn:gw',
          roleArn: 'arn:role',
          variants: [],
          evaluationConfig: { onlineEvaluationConfigArn: 'arn:eval' },
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-02T00:00:00Z',
          results: {
            analysisTimestamp: '2026-01-02T00:00:00Z',
            evaluatorMetrics: [],
          },
        })
      );

      const result = await getABTest({ region: 'us-east-1', abTestId: 'abt-123' });

      expect(result.abTestId).toBe('abt-123');
      expect(result.results).toBeDefined();
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/ab-tests/abt-123'),
        expect.objectContaining({ method: 'GET' })
      );
    });
  });

  describe('updateABTest', () => {
    it('sends PUT to /ab-tests/{id} with only defined fields', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({
          abTestId: 'abt-123',
          abTestArn: 'arn:abt:123',
          status: 'ACTIVE',
          executionStatus: 'PAUSED',
          updatedAt: '2026-01-02T00:00:00Z',
        })
      );

      await updateABTest({
        region: 'us-east-1',
        abTestId: 'abt-123',
        executionStatus: 'PAUSED',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/ab-tests/abt-123'),
        expect.objectContaining({ method: 'PUT' })
      );

      const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
      expect(body.executionStatus).toBe('PAUSED');
      expect(body.clientToken).toBeDefined();
      expect(body.name).toBeUndefined();
      expect(body.description).toBeUndefined();
      expect(body.variants).toBeUndefined();
    });

    it('includes all provided fields', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({
          abTestId: 'abt-123',
          abTestArn: 'arn:abt:123',
          status: 'ACTIVE',
          executionStatus: 'RUNNING',
          updatedAt: '2026-01-02T00:00:00Z',
        })
      );

      await updateABTest({
        region: 'us-east-1',
        abTestId: 'abt-123',
        name: 'Updated',
        description: 'New desc',
        maxDurationDays: 60,
        roleArn: 'arn:new-role',
      });

      const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
      expect(body.name).toBe('Updated');
      expect(body.description).toBe('New desc');
      expect(body.maxDurationDays).toBe(60);
      expect(body.roleArn).toBe('arn:new-role');
    });
  });

  describe('deleteABTest', () => {
    it('sends DELETE to /ab-tests/{id} and returns success', async () => {
      mockFetch.mockResolvedValue(mockJsonResponse({}, 204));

      const result = await deleteABTest({ region: 'us-east-1', abTestId: 'abt-123' });

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/ab-tests/abt-123'),
        expect.objectContaining({ method: 'DELETE' })
      );
    });

    it('returns error on 404', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        headers: new Map([['x-amzn-requestid', 'test-request-id']]),
        text: () => Promise.resolve('Not Found'),
      });

      const result = await deleteABTest({ region: 'us-east-1', abTestId: 'abt-999' });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0]![0]).toContain('/ab-tests/abt-999');
      expect(result.success).toBe(false);
      expect(result.error).toContain('ABTest API error (404)');
    });

    it('returns error on network failure', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const result = await deleteABTest({ region: 'us-east-1', abTestId: 'abt-123' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network error');
    });
  });

  describe('listABTests', () => {
    it('sends GET to /ab-tests', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({
          abTests: [
            {
              abTestId: 'abt-1',
              abTestArn: 'arn:abt:1',
              name: 'Test1',
              status: 'ACTIVE',
              executionStatus: 'RUNNING',
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:00Z',
            },
          ],
        })
      );

      const result = await listABTests({ region: 'us-east-1' });

      expect(result.abTests).toHaveLength(1);
      expect(result.abTests[0]!.name).toBe('Test1');
    });

    it('passes maxResults and nextToken as query params', async () => {
      mockFetch.mockResolvedValue(mockJsonResponse({ abTests: [] }));

      await listABTests({ region: 'us-east-1', maxResults: 10, nextToken: 'abc' });

      const url = mockFetch.mock.calls[0]![0] as string;
      expect(url).toContain('maxResults=10');
      expect(url).toContain('nextToken=abc');
    });

    it('returns empty array when response has no abTests', async () => {
      mockFetch.mockResolvedValue(mockJsonResponse({}));

      const result = await listABTests({ region: 'us-east-1' });

      expect(result.abTests).toEqual([]);
    });
  });
});
