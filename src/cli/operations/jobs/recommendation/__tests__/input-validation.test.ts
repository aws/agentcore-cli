import { ValidationError } from '../../../../../lib';
import {
  MAX_INLINE_SPANS,
  MAX_TOOL_NAME_LENGTH,
  RECOMMENDATION_NAME_REGEX,
  TOOL_NAME_REGEX,
} from '../../shared/constants';
import { buildRecommendationConfig } from '../build-config';
import { describe, expect, it } from 'vitest';

describe('RECOMMENDATION_NAME_REGEX', () => {
  it('accepts valid names', () => {
    expect(RECOMMENDATION_NAME_REGEX.test('myRec')).toBe(true);
    expect(RECOMMENDATION_NAME_REGEX.test('A123_test-run')).toBe(true);
    expect(RECOMMENDATION_NAME_REGEX.test('a')).toBe(true);
    expect(RECOMMENDATION_NAME_REGEX.test('a'.repeat(48))).toBe(true);
  });

  it('rejects names starting with a number', () => {
    expect(RECOMMENDATION_NAME_REGEX.test('1badName')).toBe(false);
  });

  it('rejects names with spaces', () => {
    expect(RECOMMENDATION_NAME_REGEX.test('my rec')).toBe(false);
  });

  it('rejects names with special characters', () => {
    expect(RECOMMENDATION_NAME_REGEX.test('my.rec')).toBe(false);
    expect(RECOMMENDATION_NAME_REGEX.test('rec@name')).toBe(false);
  });

  it('rejects names exceeding 48 characters', () => {
    expect(RECOMMENDATION_NAME_REGEX.test('a'.repeat(49))).toBe(false);
  });

  it('rejects empty string', () => {
    expect(RECOMMENDATION_NAME_REGEX.test('')).toBe(false);
  });
});

describe('TOOL_NAME_REGEX', () => {
  it('accepts valid tool names', () => {
    expect(TOOL_NAME_REGEX.test('search')).toBe(true);
    expect(TOOL_NAME_REGEX.test('my_tool')).toBe(true);
    expect(TOOL_NAME_REGEX.test('my-tool')).toBe(true);
    expect(TOOL_NAME_REGEX.test('my.tool.v2')).toBe(true);
    expect(TOOL_NAME_REGEX.test('Tool123')).toBe(true);
  });

  it('rejects tool names with spaces', () => {
    expect(TOOL_NAME_REGEX.test('my tool')).toBe(false);
  });

  it('rejects tool names with special characters', () => {
    expect(TOOL_NAME_REGEX.test('tool@name')).toBe(false);
    expect(TOOL_NAME_REGEX.test('tool/name')).toBe(false);
    expect(TOOL_NAME_REGEX.test('tool:name')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(TOOL_NAME_REGEX.test('')).toBe(false);
  });
});

describe('buildRecommendationConfig — tool name validation', () => {
  const baseOpts = {
    type: 'TOOL_DESCRIPTION_RECOMMENDATION' as const,
    inputSource: 'inline',
    traceSource: 'batch-evaluation',
    batchEvaluationArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:batch-evaluation/test-ABCDE12345',
    runtimeId: 'proj_agent-abc123',
    accountId: '123456789012',
    region: 'us-east-1',
    evaluatorIds: ['arn:aws:bedrock-agentcore:::evaluator/Builtin.Correctness'],
  };

  it('rejects tool names with spaces', async () => {
    await expect(buildRecommendationConfig({ ...baseOpts, tools: ['my tool:does stuff'] })).rejects.toThrow(
      ValidationError
    );
  });

  it('rejects tool names exceeding max length', async () => {
    const longName = 'a'.repeat(MAX_TOOL_NAME_LENGTH + 1);
    await expect(buildRecommendationConfig({ ...baseOpts, tools: [`${longName}:description`] })).rejects.toThrow(
      ValidationError
    );
  });

  it('accepts valid tool names', async () => {
    const result = await buildRecommendationConfig({ ...baseOpts, tools: ['my_tool-v2.0:Does things'] });
    expect(result.toolDescriptionRecommendationConfig).toBeDefined();
  });
});

describe('buildRecommendationConfig — online-evaluation trace source', () => {
  const onlineEvalArn = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:online-evaluation-config/test-ABCDE12345';
  const baseOpts = {
    type: 'SYSTEM_PROMPT_RECOMMENDATION' as const,
    inlineContent: 'You are helpful',
    inputSource: 'inline',
    traceSource: 'online-evaluation',
    runtimeId: '',
    accountId: '',
    region: 'us-east-1',
    evaluatorIds: ['arn:aws:bedrock-agentcore:::evaluator/Builtin.Correctness'],
  };

  it('builds an onlineEvaluation agentTraces member from the ARN', async () => {
    const result = await buildRecommendationConfig({ ...baseOpts, onlineEvaluationArn: onlineEvalArn });
    const traces = result.systemPromptRecommendationConfig?.agentTraces;
    expect(traces?.onlineEvaluation?.onlineEvaluationConfigArn).toBe(onlineEvalArn);
    // Both bounds are @required by the service.
    expect(traces?.onlineEvaluation?.startTime).toBeDefined();
    expect(traces?.onlineEvaluation?.endTime).toBeDefined();
    // No other trace member should be populated for this source.
    expect(traces?.cloudwatchLogs).toBeUndefined();
    expect(traces?.batchEvaluation).toBeUndefined();
    expect(traces?.sessionSpans).toBeUndefined();
  });

  it('derives the window from lookbackDays (startTime = now - lookback)', async () => {
    const result = await buildRecommendationConfig({
      ...baseOpts,
      onlineEvaluationArn: onlineEvalArn,
      lookbackDays: 3,
    });
    const traces = result.systemPromptRecommendationConfig!.agentTraces.onlineEvaluation!;
    const spanMs = new Date(traces.endTime).getTime() - new Date(traces.startTime).getTime();
    // 3 days ± a small tolerance for clock drift across the two Date.now() reads.
    expect(spanMs).toBeGreaterThan(3 * 24 * 60 * 60 * 1000 - 5000);
    expect(spanMs).toBeLessThan(3 * 24 * 60 * 60 * 1000 + 5000);
  });

  it('throws when --online-evaluation-arn is missing', async () => {
    await expect(buildRecommendationConfig({ ...baseOpts })).rejects.toThrow('--online-evaluation-arn is required');
  });

  it('omits evaluationConfig entirely with zero evaluators (inherits from the referenced evaluation)', async () => {
    const result = await buildRecommendationConfig({
      ...baseOpts,
      onlineEvaluationArn: onlineEvalArn,
      evaluatorIds: [],
    });
    const config = result.systemPromptRecommendationConfig!;
    // Must not serialize to the malformed {"evaluators":[{}]}; the key should be absent altogether.
    expect('evaluationConfig' in config).toBe(false);
    expect(config.evaluationConfig).toBeUndefined();
  });
});

describe('buildRecommendationConfig — spans limit validation', () => {
  it('rejects spans file exceeding max count', async () => {
    const { writeFileSync, mkdtempSync, rmSync } = await import('fs');
    const { join } = await import('path');
    const tmpDir = mkdtempSync('/tmp/spans-test-');
    const spansFile = join(tmpDir, 'spans.json');
    try {
      const spans = Array.from({ length: MAX_INLINE_SPANS + 1 }, (_, i) => ({
        traceId: `trace-${i}`,
        spanId: `span-${i}`,
      }));
      writeFileSync(spansFile, JSON.stringify(spans));

      await expect(
        buildRecommendationConfig({
          type: 'SYSTEM_PROMPT_RECOMMENDATION',
          inlineContent: 'You are helpful',
          inputSource: 'inline',
          traceSource: 'spans-file',
          spansFile,
          runtimeId: 'proj_agent-abc123',
          accountId: '123456789012',
          region: 'us-east-1',
          evaluatorIds: ['arn:aws:bedrock-agentcore:::evaluator/Builtin.Correctness'],
        })
      ).rejects.toThrow(ValidationError);
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it('accepts spans file within limit', async () => {
    const { writeFileSync, mkdtempSync, rmSync } = await import('fs');
    const { join } = await import('path');
    const tmpDir = mkdtempSync('/tmp/spans-test-');
    const spansFile = join(tmpDir, 'spans.json');
    try {
      const spans = Array.from({ length: 5 }, (_, i) => ({
        traceId: `trace-${i}`,
        spanId: `span-${i}`,
      }));
      writeFileSync(spansFile, JSON.stringify(spans));

      const result = await buildRecommendationConfig({
        type: 'SYSTEM_PROMPT_RECOMMENDATION',
        inlineContent: 'You are helpful',
        inputSource: 'inline',
        traceSource: 'spans-file',
        spansFile,
        runtimeId: 'proj_agent-abc123',
        accountId: '123456789012',
        region: 'us-east-1',
        evaluatorIds: ['arn:aws:bedrock-agentcore:::evaluator/Builtin.Correctness'],
      });
      expect(result.systemPromptRecommendationConfig).toBeDefined();
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });
});
