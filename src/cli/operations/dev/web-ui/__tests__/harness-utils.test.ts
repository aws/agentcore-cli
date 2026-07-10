import type { HarnessModel } from '../../../../../schema';
import { buildInvokeOptions } from '../handlers/harness-utils';
import { describe, expect, it } from 'vitest';

const ARN = 'arn:aws:bedrock:us-west-2:123:harness/h-123';

describe('buildInvokeOptions — model resolution', () => {
  const specModel: HarnessModel = { provider: 'bedrock', modelId: 'anthropic.claude-sonnet-4-5', maxTokens: 4096 };

  it('sends no model when neither an override nor a spec model is available', () => {
    const opts = buildInvokeOptions(ARN, 'us-west-2', 's-1', []);
    expect(opts.model).toBeUndefined();
  });

  it('defaults the model from the local spec so maxTokens applies without a redeploy', () => {
    const opts = buildInvokeOptions(ARN, 'us-west-2', 's-1', [], undefined, specModel);
    expect(opts.model).toEqual({
      bedrockModelConfig: { modelId: 'anthropic.claude-sonnet-4-5', maxTokens: 4096 },
    });
  });

  it('prefers an explicit UI model override over the spec model', () => {
    const override = { bedrockModelConfig: { modelId: 'other-model', maxTokens: 100 } };
    const opts = buildInvokeOptions(ARN, 'us-west-2', 's-1', [], { model: override }, specModel);
    expect(opts.model).toEqual(override);
  });

  it('uses the spec model when overrides carry only non-model fields', () => {
    const opts = buildInvokeOptions(ARN, 'us-west-2', 's-1', [], { skills: [{ path: './skills' }] }, specModel);
    expect(opts.model).toEqual({
      bedrockModelConfig: { modelId: 'anthropic.claude-sonnet-4-5', maxTokens: 4096 },
    });
    expect(opts.skills).toEqual([{ path: './skills' }]);
  });

  it('defaults an OpenAI model with maxTokens + apiKeyArn (dropping converse_stream apiFormat)', () => {
    const openAiModel: HarnessModel = {
      provider: 'open_ai',
      modelId: 'gpt-4.1',
      apiKeyArn: 'arn:aws:secretsmanager:us-east-1:123:secret/openai',
      maxTokens: 2048,
      temperature: 0.5,
    };
    const opts = buildInvokeOptions(ARN, 'us-west-2', 's-1', [], undefined, openAiModel);
    expect(opts.model).toEqual({
      openAiModelConfig: {
        modelId: 'gpt-4.1',
        temperature: 0.5,
        maxTokens: 2048,
        apiKeyArn: 'arn:aws:secretsmanager:us-east-1:123:secret/openai',
      },
    });
  });

  it('defaults a Gemini model with maxTokens + topK', () => {
    const geminiModel: HarnessModel = {
      provider: 'gemini',
      modelId: 'gemini-2.5-flash',
      apiKeyArn: 'arn:aws:secretsmanager:us-east-1:123:secret/gemini',
      maxTokens: 512,
      topK: 40,
    };
    const opts = buildInvokeOptions(ARN, 'us-west-2', 's-1', [], undefined, geminiModel);
    expect(opts.model).toEqual({
      geminiModelConfig: {
        modelId: 'gemini-2.5-flash',
        maxTokens: 512,
        apiKeyArn: 'arn:aws:secretsmanager:us-east-1:123:secret/gemini',
        topK: 40,
      },
    });
  });

  it('defaults a LiteLLM model with maxTokens + apiBase + additionalParams', () => {
    const liteLlmModel: HarnessModel = {
      provider: 'lite_llm',
      modelId: 'bedrock/us.anthropic.claude-sonnet-4-5',
      maxTokens: 8192,
      apiBase: 'https://proxy.example.com',
      additionalParams: { foo: 'bar' },
    };
    const opts = buildInvokeOptions(ARN, 'us-west-2', 's-1', [], undefined, liteLlmModel);
    expect(opts.model).toEqual({
      liteLlmModelConfig: {
        modelId: 'bedrock/us.anthropic.claude-sonnet-4-5',
        maxTokens: 8192,
        apiBase: 'https://proxy.example.com',
        additionalParams: { foo: 'bar' },
      },
    });
  });
});
