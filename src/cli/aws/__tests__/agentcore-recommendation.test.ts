import {
  deleteRecommendation,
  getRecommendation,
  listRecommendations,
  startRecommendation,
} from '../agentcore-recommendation.js';
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

describe('agentcore-recommendation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('startRecommendation', () => {
    it('sends POST to /recommendations with correct body', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({
          recommendationId: 'rec-123',
          recommendationArn: 'arn:rec-123',
          name: 'MyRecommendation',
          type: 'SYSTEM_PROMPT_RECOMMENDATION',
          status: 'PENDING',
        })
      );

      const result = await startRecommendation({
        region: 'us-west-2',
        name: 'MyRecommendation',
        type: 'SYSTEM_PROMPT_RECOMMENDATION',
        recommendationConfig: {
          systemPromptRecommendationConfig: {
            systemPrompt: { text: 'You are a helpful agent.' },
            agentTraces: {
              cloudwatchLogs: {
                logGroupArns: ['arn:log-group'],
                serviceNames: ['bedrock-agentcore'],
                startTime: '2026-03-23T00:00:00.000Z',
                endTime: '2026-03-30T00:00:00.000Z',
              },
            },
            evaluationConfig: {
              evaluators: [{ evaluatorArn: 'arn:aws:bedrock-agentcore:::evaluator/Builtin.Helpfulness' }],
            },
          },
        },
      });

      expect(result.recommendationId).toBe('rec-123');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/recommendations'),
        expect.objectContaining({ method: 'POST' })
      );

      const fetchCall = mockFetch.mock.calls[0]!;
      const body = JSON.parse(fetchCall[1].body);
      expect(body.name).toBe('MyRecommendation');
      expect(body.type).toBe('SYSTEM_PROMPT_RECOMMENDATION');
      expect(body.recommendationConfig.systemPromptRecommendationConfig).toBeDefined();
    });

    it('omits description when not provided', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({
          recommendationId: 'r1',
          recommendationArn: 'arn:1',
          name: 'MyRec',
          type: 'SYSTEM_PROMPT_RECOMMENDATION',
          status: 'PENDING',
        })
      );

      await startRecommendation({
        region: 'us-west-2',
        name: 'MyRec',
        type: 'SYSTEM_PROMPT_RECOMMENDATION',
        recommendationConfig: {
          systemPromptRecommendationConfig: {
            systemPrompt: { text: '' },
            agentTraces: {
              cloudwatchLogs: {
                logGroupArns: [],
                serviceNames: ['bedrock-agentcore'],
                startTime: '2026-03-23T00:00:00.000Z',
                endTime: '2026-03-30T00:00:00.000Z',
              },
            },
            evaluationConfig: {
              evaluators: [{ evaluatorArn: 'arn:aws:bedrock-agentcore:::evaluator/Builtin.Helpfulness' }],
            },
          },
        },
      });

      const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
      expect(body.description).toBeUndefined();
    });

    it('includes description when provided', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({
          recommendationId: 'r1',
          recommendationArn: 'arn:1',
          name: 'MyRec',
          type: 'SYSTEM_PROMPT_RECOMMENDATION',
          status: 'PENDING',
        })
      );

      await startRecommendation({
        region: 'us-west-2',
        name: 'MyRec',
        description: 'Test description',
        type: 'SYSTEM_PROMPT_RECOMMENDATION',
        recommendationConfig: {
          systemPromptRecommendationConfig: {
            systemPrompt: { text: '' },
            agentTraces: {
              cloudwatchLogs: {
                logGroupArns: [],
                serviceNames: ['bedrock-agentcore'],
                startTime: '2026-03-23T00:00:00.000Z',
                endTime: '2026-03-30T00:00:00.000Z',
              },
            },
            evaluationConfig: {
              evaluators: [{ evaluatorArn: 'arn:aws:bedrock-agentcore:::evaluator/Builtin.Helpfulness' }],
            },
          },
        },
      });

      const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
      expect(body.description).toBe('Test description');
    });

    it('throws on non-ok response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        headers: new Map([['x-amzn-requestid', 'test-request-id']]),
        text: () => Promise.resolve('Bad Request'),
      });

      await expect(
        startRecommendation({
          region: 'us-west-2',
          name: 'MyRec',
          type: 'SYSTEM_PROMPT_RECOMMENDATION',
          recommendationConfig: {},
        })
      ).rejects.toThrow('Recommendation API error (400)');
    });
  });

  describe('getRecommendation', () => {
    it('sends GET to /recommendations/{id}', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({
          recommendationId: 'rec-123',
          recommendationArn: 'arn:rec-123',
          name: 'MyRec',
          type: 'SYSTEM_PROMPT_RECOMMENDATION',
          status: 'COMPLETED',
          recommendationResult: {
            systemPromptRecommendationResult: {
              recommendedSystemPrompt: 'Optimized prompt',
              explanation: 'Made it better',
            },
          },
        })
      );

      const result = await getRecommendation({ region: 'us-west-2', recommendationId: 'rec-123' });

      expect(result.recommendationId).toBe('rec-123');
      expect(result.name).toBe('MyRec');
      expect(result.recommendationResult?.systemPromptRecommendationResult?.recommendedSystemPrompt).toBe(
        'Optimized prompt'
      );
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/recommendations/rec-123'),
        expect.objectContaining({ method: 'GET' })
      );
    });
  });

  describe('deleteRecommendation', () => {
    it('sends DELETE to /recommendations/{id}', async () => {
      mockFetch.mockResolvedValue(mockJsonResponse({ recommendationId: 'rec-123', status: 'DELETING' }, 200));

      const result = await deleteRecommendation({ region: 'us-west-2', recommendationId: 'rec-123' });

      expect(result.recommendationId).toBe('rec-123');
      expect(result.status).toBe('DELETING');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/recommendations/rec-123'),
        expect.objectContaining({ method: 'DELETE' })
      );
    });

    it('throws on failure', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      await expect(deleteRecommendation({ region: 'us-west-2', recommendationId: 'rec-123' })).rejects.toThrow(
        'Network error'
      );
    });
  });

  describe('listRecommendations', () => {
    it('sends GET to /recommendations', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({
          recommendationSummaries: [
            {
              recommendationId: 'r1',
              recommendationArn: 'arn:r1',
              name: 'Rec1',
              type: 'SYSTEM_PROMPT_RECOMMENDATION',
              status: 'COMPLETED',
            },
            {
              recommendationId: 'r2',
              recommendationArn: 'arn:r2',
              name: 'Rec2',
              type: 'TOOL_DESCRIPTION_RECOMMENDATION',
              status: 'COMPLETED',
            },
          ],
        })
      );

      const result = await listRecommendations({ region: 'us-west-2' });

      expect(result.recommendationSummaries).toHaveLength(2);
      expect(result.recommendationSummaries[0]!.name).toBe('Rec1');
    });

    it('passes maxResults and nextToken as query params', async () => {
      mockFetch.mockResolvedValue(mockJsonResponse({ recommendationSummaries: [] }));

      await listRecommendations({ region: 'us-west-2', maxResults: 10, nextToken: 'abc' });

      const url = mockFetch.mock.calls[0]![0] as string;
      expect(url).toContain('maxResults=10');
      expect(url).toContain('nextToken=abc');
    });

    it('returns empty array when response has no recommendationSummaries', async () => {
      mockFetch.mockResolvedValue(mockJsonResponse({}));

      const result = await listRecommendations({ region: 'us-west-2' });

      expect(result.recommendationSummaries).toEqual([]);
    });
  });
});
