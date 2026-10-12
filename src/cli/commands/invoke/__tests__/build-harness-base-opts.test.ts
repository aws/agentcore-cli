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

describe('buildHarnessBaseOpts — skills override mapping', () => {
  it('maps an s3:// source to the InvokeHarness s3 shape', () => {
    const opts = buildHarnessBaseOpts({ ...base, skills: 's3://my-bucket/skills/style/' });
    expect(opts.skills).toEqual([{ s3: { uri: 's3://my-bucket/skills/style/' } }]);
  });

  it('maps an https:// source to the InvokeHarness git shape', () => {
    const opts = buildHarnessBaseOpts({ ...base, skills: 'https://github.com/my-org/skills' });
    expect(opts.skills).toEqual([{ git: { url: 'https://github.com/my-org/skills' } }]);
  });

  it('maps anything else to a filesystem path', () => {
    const opts = buildHarnessBaseOpts({ ...base, skills: '.agents/skills/xlsx' });
    expect(opts.skills).toEqual([{ path: '.agents/skills/xlsx' }]);
  });

  it('maps a comma-separated mix, trimming whitespace', () => {
    const opts = buildHarnessBaseOpts({
      ...base,
      skills: 's3://b/skills/a/, https://github.com/o/r ,.agents/skills/c',
    });
    expect(opts.skills).toEqual([
      { s3: { uri: 's3://b/skills/a/' } },
      { git: { url: 'https://github.com/o/r' } },
      { path: '.agents/skills/c' },
    ]);
  });
});
