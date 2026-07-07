import { createHarnessE2ESuite } from './harness-e2e-helper.js';

// LiteLLM provider routed at a Bedrock model so the deploy needs no third-party API key
// (LiteLLM's bedrock backend uses the runtime execution role's IAM). Invoke is skipped: the
// bedrock suite already proves the invoke path, and this case exists to prove the lite_llm
// model config (provider + bedrock routing) is accepted by CloudFormation on a real deploy.
createHarnessE2ESuite({
  modelProvider: 'lite_llm',
  modelId: 'bedrock/global.anthropic.claude-sonnet-4-6',
  skipMemory: true,
  skipInvoke: true,
});
