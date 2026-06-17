import { buildHarnessBaseOpts } from '../action.js';
import type { InvokeOptions } from '../types.js';
import { describe, expect, it } from 'vitest';

const base = { prompt: 'hi', targetName: 'default' } as InvokeOptions;

describe('buildHarnessBaseOpts — model provider mapping', () => {
  it('maps bedrock by default', () => {
    const opts = buildHarnessBaseOpts({ ...base, modelProvider: 'bedrock', modelId: 'm' });
    expect(opts.model).toEqual({ bedrockModelConfig: { modelId: 'm' } });
  });

  it('maps open_ai with apiKeyArn', () => {
    const opts = buildHarnessBaseOpts({ ...base, modelProvider: 'open_ai', modelId: 'gpt', apiKeyArn: 'arn:key' });
    expect(opts.model).toEqual({ openAiModelConfig: { modelId: 'gpt', apiKeyArn: 'arn:key' } });
  });

  it('maps gemini with apiKeyArn', () => {
    const opts = buildHarnessBaseOpts({ ...base, modelProvider: 'gemini', modelId: 'g', apiKeyArn: 'arn:key' });
    expect(opts.model).toEqual({ geminiModelConfig: { modelId: 'g', apiKeyArn: 'arn:key' } });
  });

  it('maps lite_llm with apiBase and additionalParams (apiKeyArn optional)', () => {
    const opts = buildHarnessBaseOpts({
      ...base,
      modelProvider: 'lite_llm',
      modelId: 'anthropic/claude-sonnet-4-5',
      apiBase: 'https://proxy.example.com/v1',
      additionalParams: { reasoning_effort: 'high' },
    });
    expect(opts.model).toEqual({
      liteLlmModelConfig: {
        modelId: 'anthropic/claude-sonnet-4-5',
        apiBase: 'https://proxy.example.com/v1',
        additionalParams: { reasoning_effort: 'high' },
      },
    });
  });

  it('maps a keyless lite_llm override from only apiBase', () => {
    const opts = buildHarnessBaseOpts({
      ...base,
      modelProvider: 'lite_llm',
      modelId: 'ollama/llama3',
      apiBase: 'http://localhost:11434',
    });
    expect(opts.model).toEqual({
      liteLlmModelConfig: { modelId: 'ollama/llama3', apiBase: 'http://localhost:11434' },
    });
  });

  it('falls back to the harness spec provider when no override is given', () => {
    const opts = buildHarnessBaseOpts({ ...base, apiBase: 'https://proxy' }, { provider: 'lite_llm', modelId: 'm' });
    expect(opts.model).toEqual({ liteLlmModelConfig: { modelId: 'm', apiBase: 'https://proxy' } });
  });
});
