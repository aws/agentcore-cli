import { getProxyRequestHandler } from '../../lib/utils/aws-proxy';
import { getCredentialProvider } from './account';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

/**
 * Options for invoking a Bedrock model synchronously.
 */
export interface BedrockInvokeOptions {
  region: string;
  modelId: string;
  body: Record<string, unknown>;
}

/**
 * Invoke a Bedrock model synchronously and return the raw response body.
 */
export async function invokeBedrockSync(options: BedrockInvokeOptions): Promise<Record<string, unknown>> {
  const client = new BedrockRuntimeClient({
    region: options.region,
    credentials: getCredentialProvider(),
    requestHandler: getProxyRequestHandler(),
  });

  const command = new InvokeModelCommand({
    modelId: options.modelId,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(options.body),
  });

  const response = await client.send(command);
  return JSON.parse(new TextDecoder().decode(response.body)) as Record<string, unknown>;
}

/**
 * Claude-specific model configuration.
 */
const CLAUDE_MODEL_ID = 'global.anthropic.claude-opus-4-5-20251101-v1:0';
const CLAUDE_ANTHROPIC_VERSION = 'bedrock-2023-05-31';

export interface ClaudeInvokeOptions {
  region: string;
  prompt: string;
  maxTokens?: number;
}

export interface ClaudeResponse {
  content: string;
}

/**
 * Invoke Claude on Bedrock with a prompt and return the response text.
 */
export async function invokeClaude(options: ClaudeInvokeOptions): Promise<ClaudeResponse> {
  const body = {
    anthropic_version: CLAUDE_ANTHROPIC_VERSION,
    max_tokens: options.maxTokens ?? 8192,
    messages: [{ role: 'user', content: options.prompt }],
  };

  const response = await invokeBedrockSync({
    region: options.region,
    modelId: CLAUDE_MODEL_ID,
    body,
  });

  const content = response.content as { type: string; text: string }[];
  const firstContent = content[0];
  if (!firstContent) {
    throw new Error('No content returned from Bedrock');
  }
  return { content: firstContent.text };
}
