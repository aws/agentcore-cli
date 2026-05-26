{{#if (eq modelProvider "Bedrock")}}
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';

const provider = fromNodeProviderChain();

const bedrock = createAmazonBedrock({
  region: process.env.AWS_REGION ?? 'us-east-1',
  credentialProvider: async () => {
    const creds = await provider();
    return {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    };
  },
});

export function loadModel() {
  return bedrock('us.anthropic.claude-sonnet-4-5-20250929-v1:0');
}
{{/if}}
{{#if (eq modelProvider "Anthropic")}}
import { createAnthropic } from '@ai-sdk/anthropic';
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

let _anthropic: ReturnType<typeof createAnthropic> | undefined;

async function getProvider() {
  if (!_anthropic) {
    const apiKey = await getApiKey();
    _anthropic = createAnthropic({ apiKey });
  }
  return _anthropic;
}

export async function loadModel() {
  const anthropic = await getProvider();
  return anthropic('claude-sonnet-4-5-20250929');
}
{{/if}}
{{#if (eq modelProvider "OpenAI")}}
import { createOpenAI } from '@ai-sdk/openai';
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

let _openai: ReturnType<typeof createOpenAI> | undefined;

async function getProvider() {
  if (!_openai) {
    const apiKey = await getApiKey();
    _openai = createOpenAI({ apiKey });
  }
  return _openai;
}

export async function loadModel() {
  const openai = await getProvider();
  return openai('gpt-4.1');
}
{{/if}}
{{#if (eq modelProvider "Gemini")}}
import { createGoogleGenerativeAI } from '@ai-sdk/google';
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

let _google: ReturnType<typeof createGoogleGenerativeAI> | undefined;

async function getProvider() {
  if (!_google) {
    const apiKey = await getApiKey();
    _google = createGoogleGenerativeAI({ apiKey });
  }
  return _google;
}

export async function loadModel() {
  const google = await getProvider();
  return google('gemini-2.5-flash');
}
{{/if}}
