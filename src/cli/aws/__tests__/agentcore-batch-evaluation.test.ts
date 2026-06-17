import {
  deleteBatchEvaluation,
  getBatchEvaluation,
  listBatchEvaluations,
  startBatchEvaluation,
  stopBatchEvaluation,
} from '../agentcore-batch-evaluation.js';
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

describe('agentcore-batch-evaluation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('startBatchEvaluation', () => {
    it('sends POST to /evaluations/batch-evaluate with correct body', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({
          batchEvaluationId: 'batch-123',
          batchEvaluationArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:batch-evaluation/batch-123',
          batchEvaluationName: 'MyBatchEval',
          status: 'PENDING',
        })
      );

      const result = await startBatchEvaluation({
        region: 'us-west-2',
        name: 'MyBatchEval',
        evaluators: [{ evaluatorId: 'eval-1' }],
        dataSourceConfig: {
          cloudWatchLogs: {
            serviceNames: ['bedrock-agentcore'],
            logGroupNames: ['my-log-group'],
          },
        },
      });

      expect(result.batchEvaluationId).toBe('batch-123');
      expect(result.name).toBe('MyBatchEval');
      expect(result.status).toBe('PENDING');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/evaluations/batch-evaluate'),
        expect.objectContaining({ method: 'POST' })
      );

      const fetchCall = mockFetch.mock.calls[0]!;
      const body = JSON.parse(fetchCall[1].body);
      expect(body.batchEvaluationName).toBe('MyBatchEval');
      expect(body.evaluators).toEqual([{ evaluatorId: 'eval-1' }]);
    });

    it('includes kmsKeyArn when provided', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({
          batchEvaluationId: 'batch-123',
          batchEvaluationArn: 'arn:batch-123',
          batchEvaluationName: 'MyBatchEval',
          status: 'PENDING',
        })
      );

      await startBatchEvaluation({
        region: 'us-west-2',
        name: 'MyBatchEval',
        evaluators: [{ evaluatorId: 'eval-1' }],
        dataSourceConfig: {
          cloudWatchLogs: {
            serviceNames: ['bedrock-agentcore'],
            logGroupNames: ['my-log-group'],
          },
        },
        kmsKeyArn: 'arn:aws:kms:us-west-2:123456789012:key/12345678-1234-1234-1234-123456789012',
      });

      const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
      expect(body.kmsKeyArn).toBe('arn:aws:kms:us-west-2:123456789012:key/12345678-1234-1234-1234-123456789012');
    });

    it('omits kmsKeyArn when not provided', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({
          batchEvaluationId: 'batch-123',
          batchEvaluationArn: 'arn:batch-123',
          batchEvaluationName: 'MyBatchEval',
          status: 'PENDING',
        })
      );

      await startBatchEvaluation({
        region: 'us-west-2',
        name: 'MyBatchEval',
        evaluators: [{ evaluatorId: 'eval-1' }],
        dataSourceConfig: {
          cloudWatchLogs: {
            serviceNames: ['bedrock-agentcore'],
            logGroupNames: ['my-log-group'],
          },
        },
      });

      const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
      expect(body.kmsKeyArn).toBeUndefined();
    });

    it('includes description when provided', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({
          batchEvaluationId: 'batch-123',
          batchEvaluationArn: 'arn:batch-123',
          batchEvaluationName: 'MyBatchEval',
          status: 'PENDING',
        })
      );

      await startBatchEvaluation({
        region: 'us-west-2',
        name: 'MyBatchEval',
        evaluators: [{ evaluatorId: 'eval-1' }],
        dataSourceConfig: {
          cloudWatchLogs: {
            serviceNames: ['bedrock-agentcore'],
            logGroupNames: ['my-log-group'],
          },
        },
        description: 'Test evaluation run',
      });

      const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
      expect(body.description).toBe('Test evaluation run');
    });

    it('includes clientToken when provided', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({
          batchEvaluationId: 'batch-123',
          batchEvaluationArn: 'arn:batch-123',
          batchEvaluationName: 'MyBatchEval',
          status: 'PENDING',
        })
      );

      await startBatchEvaluation({
        region: 'us-west-2',
        name: 'MyBatchEval',
        evaluators: [{ evaluatorId: 'eval-1' }],
        dataSourceConfig: {
          cloudWatchLogs: {
            serviceNames: ['bedrock-agentcore'],
            logGroupNames: ['my-log-group'],
          },
        },
        clientToken: 'token-abc',
      });

      const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
      expect(body.clientToken).toBe('token-abc');
    });

    it('includes evaluationMetadata when provided', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({
          batchEvaluationId: 'batch-123',
          batchEvaluationArn: 'arn:batch-123',
          batchEvaluationName: 'MyBatchEval',
          status: 'PENDING',
        })
      );

      await startBatchEvaluation({
        region: 'us-west-2',
        name: 'MyBatchEval',
        evaluators: [{ evaluatorId: 'eval-1' }],
        dataSourceConfig: {
          cloudWatchLogs: {
            serviceNames: ['bedrock-agentcore'],
            logGroupNames: ['my-log-group'],
          },
        },
        evaluationMetadata: {
          sessionMetadata: [{ sessionId: 'sess-1', metadata: { referenceAnswer: 'answer' } }],
        },
      });

      const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
      expect(body.evaluationMetadata.sessionMetadata).toEqual([
        { sessionId: 'sess-1', metadata: { referenceAnswer: 'answer' } },
      ]);
    });

    it('throws on non-ok response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        headers: new Map([['x-amzn-requestid', 'test-request-id']]),
        text: () => Promise.resolve('Bad Request'),
      });

      await expect(
        startBatchEvaluation({
          region: 'us-west-2',
          name: 'MyBatchEval',
          evaluators: [],
          dataSourceConfig: {
            cloudWatchLogs: { serviceNames: [], logGroupNames: [] },
          },
        })
      ).rejects.toThrow('BatchEvaluation API error (400)');
    });
  });

  describe('getBatchEvaluation', () => {
    it('sends GET to /evaluations/batch-evaluate/{id}', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({
          batchEvaluationId: 'batch-123',
          batchEvaluationArn: 'arn:batch-123',
          batchEvaluationName: 'MyBatchEval',
          status: 'COMPLETED',
          kmsKeyArn: 'arn:aws:kms:us-west-2:123456789012:key/12345678-1234-1234-1234-123456789012',
        })
      );

      const result = await getBatchEvaluation({ region: 'us-west-2', batchEvaluationId: 'batch-123' });

      expect(result.batchEvaluationId).toBe('batch-123');
      expect(result.name).toBe('MyBatchEval');
      expect(result.status).toBe('COMPLETED');
      expect(result.kmsKeyArn).toBe('arn:aws:kms:us-west-2:123456789012:key/12345678-1234-1234-1234-123456789012');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/evaluations/batch-evaluate/batch-123'),
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('returns undefined kmsKeyArn when not present in response', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({
          batchEvaluationId: 'batch-123',
          batchEvaluationArn: 'arn:batch-123',
          batchEvaluationName: 'MyBatchEval',
          status: 'COMPLETED',
        })
      );

      const result = await getBatchEvaluation({ region: 'us-west-2', batchEvaluationId: 'batch-123' });
      expect(result.kmsKeyArn).toBeUndefined();
    });
  });

  describe('listBatchEvaluations', () => {
    it('sends GET to /evaluations/batch-evaluate', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({
          batchEvaluations: [
            { batchEvaluationId: 'b1', name: 'Eval1', status: 'COMPLETED' },
            { batchEvaluationId: 'b2', name: 'Eval2', status: 'PENDING' },
          ],
        })
      );

      const result = await listBatchEvaluations({ region: 'us-west-2' });

      expect(result.batchEvaluations).toHaveLength(2);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/evaluations/batch-evaluate'),
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('includes maxResults and nextToken query params', async () => {
      mockFetch.mockResolvedValue(mockJsonResponse({ batchEvaluations: [], nextToken: undefined }));

      await listBatchEvaluations({ region: 'us-west-2', maxResults: 5, nextToken: 'page2' });

      const url = mockFetch.mock.calls[0]![0] as string;
      expect(url).toContain('maxResults=5');
      expect(url).toContain('nextToken=page2');
    });
  });

  describe('stopBatchEvaluation', () => {
    it('sends POST to /evaluations/batch-evaluate/{id}/stop', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({
          batchEvaluationId: 'batch-123',
          status: 'STOPPING',
        })
      );

      const result = await stopBatchEvaluation({ region: 'us-west-2', batchEvaluationId: 'batch-123' });

      expect(result.batchEvaluationId).toBe('batch-123');
      expect(result.status).toBe('STOPPING');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/evaluations/batch-evaluate/batch-123/stop'),
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  describe('deleteBatchEvaluation', () => {
    it('sends DELETE to /evaluations/batch-evaluate/{id}', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 204,
        headers: new Map(),
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(''),
      });

      await deleteBatchEvaluation({ region: 'us-west-2', batchEvaluationId: 'batch-123' });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/evaluations/batch-evaluate/batch-123'),
        expect.objectContaining({ method: 'DELETE' })
      );
    });
  });
});
