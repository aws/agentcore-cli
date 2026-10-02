{{#if (eq modelProvider "Bedrock")}}
import { BedrockModel } from '@strands-agents/sdk/models/bedrock';

export async function loadModel(): Promise<BedrockModel> {
  return new BedrockModel({ modelId: {{safeJson modelId}} });
}
{{/if}}
{{#if (eq modelProvider "Anthropic")}}
import { AnthropicModel } from '@strands-agents/sdk/models/anthropic';
import { getApiKey } from './apiKey.js';

export async function loadModel(): Promise<AnthropicModel> {
  return new AnthropicModel({ apiKey: await getApiKey(), modelId: {{safeJson modelId}} });
}
{{/if}}
{{#if (eq modelProvider "OpenAI")}}
import { OpenAIModel } from '@strands-agents/sdk/models/openai';
import { getApiKey } from './apiKey.js';

export async function loadModel(): Promise<OpenAIModel> {
  return new OpenAIModel({
    apiKey: await getApiKey(),
    modelId: {{safeJson modelId}},
{{#if apiBase}}
    // An OpenAI-compatible endpoint instead of api.openai.com.
    clientConfig: { baseURL: {{safeJson apiBase}} },
{{/if}}
  });
}
{{/if}}
{{#if (eq modelProvider "Gemini")}}
import { GoogleModel } from '@strands-agents/sdk/models/google';
import { getApiKey } from './apiKey.js';

export async function loadModel(): Promise<GoogleModel> {
  return new GoogleModel({ apiKey: await getApiKey(), modelId: {{safeJson modelId}} });
}
{{/if}}
