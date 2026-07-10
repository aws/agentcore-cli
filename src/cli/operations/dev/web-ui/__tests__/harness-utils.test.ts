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

  it('sends no default override for non-bedrock providers', () => {
    const geminiModel: HarnessModel = {
      provider: 'gemini',
      modelId: 'gemini-2.5-flash',
      apiKeyArn: 'arn:aws:secretsmanager:us-east-1:123:secret/gemini',
      maxTokens: 512,
    };
    const opts = buildInvokeOptions(ARN, 'us-west-2', 's-1', [], undefined, geminiModel);
    expect(opts.model).toBeUndefined();
  });
});
