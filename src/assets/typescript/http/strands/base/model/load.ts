{{#if (eq modelProvider "Bedrock")}}
import { BedrockModel } from '@strands-agents/sdk/models/bedrock';

export function loadModel(): BedrockModel {
  return new BedrockModel({ modelId: 'global.anthropic.claude-sonnet-4-5-20250929-v1:0' });
}
{{/if}}
{{#if (eq modelProvider "Anthropic")}}
import { AnthropicModel } from '@strands-agents/sdk/models/anthropic';
import { withApiKey } from 'bedrock-agentcore/identity';

const IDENTITY_PROVIDER_NAME = '{{identityProviders.[0].name}}';
const IDENTITY_ENV_VAR = '{{identityProviders.[0].envVarName}}';

async function getApiKey(): Promise<string> {
  if (process.env.LOCAL_DEV === '1') {
    const apiKey = process.env[IDENTITY_ENV_VAR] ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(`${IDENTITY_ENV_VAR} or ANTHROPIC_API_KEY not found. Add your key to agentcore/.env.local`);
    }
    return apiKey;
  }
  return withApiKey({ providerName: IDENTITY_PROVIDER_NAME })(async (apiKey: string) => apiKey)();
}

let _model: AnthropicModel | undefined;

export async function loadModel(): Promise<AnthropicModel> {
  if (!_model) {
    const apiKey = await getApiKey();
    _model = new AnthropicModel({
      apiKey,
      modelId: 'claude-sonnet-4-5-20250929',
      maxTokens: 5000,
    });
  }
  return _model;
}
{{/if}}
{{#if (eq modelProvider "OpenAI")}}
import { OpenAIModel } from '@strands-agents/sdk/models/openai';
import { withApiKey } from 'bedrock-agentcore/identity';

const IDENTITY_PROVIDER_NAME = '{{identityProviders.[0].name}}';
const IDENTITY_ENV_VAR = '{{identityProviders.[0].envVarName}}';

async function getApiKey(): Promise<string> {
  if (process.env.LOCAL_DEV === '1') {
    const apiKey = process.env[IDENTITY_ENV_VAR] ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(`${IDENTITY_ENV_VAR} or OPENAI_API_KEY not found. Add your key to agentcore/.env.local`);
    }
    return apiKey;
  }
  return withApiKey({ providerName: IDENTITY_PROVIDER_NAME })(async (apiKey: string) => apiKey)();
}

let _model: OpenAIModel | undefined;

export async function loadModel(): Promise<OpenAIModel> {
  if (!_model) {
    const apiKey = await getApiKey();
    _model = new OpenAIModel({
      api: 'chat',
      apiKey,
      modelId: 'gpt-4.1',
    });
  }
  return _model;
}
{{/if}}
{{#if (eq modelProvider "Gemini")}}
import { GoogleModel } from '@strands-agents/sdk/models/google';
import { withApiKey } from 'bedrock-agentcore/identity';

const IDENTITY_PROVIDER_NAME = '{{identityProviders.[0].name}}';
const IDENTITY_ENV_VAR = '{{identityProviders.[0].envVarName}}';

async function getApiKey(): Promise<string> {
  if (process.env.LOCAL_DEV === '1') {
    const apiKey = process.env[IDENTITY_ENV_VAR] ?? process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error(`${IDENTITY_ENV_VAR} or GEMINI_API_KEY not found. Add your key to agentcore/.env.local`);
    }
    return apiKey;
  }
  return withApiKey({ providerName: IDENTITY_PROVIDER_NAME })(async (apiKey: string) => apiKey)();
}

let _model: GoogleModel | undefined;

export async function loadModel(): Promise<GoogleModel> {
  if (!_model) {
    const apiKey = await getApiKey();
    _model = new GoogleModel({
      apiKey,
      modelId: 'gemini-2.5-flash',
    });
  }
  return _model;
}
{{/if}}
