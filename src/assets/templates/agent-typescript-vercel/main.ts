import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { streamText } from 'ai';
import { z } from 'zod';

const SYSTEM_PROMPT = `You are a helpful assistant.`;

const bedrock = createAmazonBedrock({
  region: process.env.AWS_REGION ?? 'us-east-1',
  credentialProvider: fromNodeProviderChain(),
});

const requestSchema = z.object({
  prompt: z.string().default(''),
});

// The Runtime preloads ADOT, but its Vercel AI auto-instrumentation patches `ai` at import time,
// and esbuild inlines `ai` into the CodeZip bundle, so there is no import left to patch. The SDK's
// own telemetry reports to the global tracer ADOT registers, whatever the bundling.
const AI_TELEMETRY = { isEnabled: process.env.AGENT_OBSERVABILITY_ENABLED === 'true' };

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    requestSchema,
    async *process(payload) {
      const result = streamText({
        model: bedrock('global.anthropic.claude-sonnet-5-5'),
        system: SYSTEM_PROMPT,
        prompt: payload.prompt,
        experimental_telemetry: AI_TELEMETRY,
      });

      for await (const chunk of result.textStream) {
        yield { data: chunk };
      }
    },
  },
});

app.run({ port: parseInt(process.env.PORT ?? '8080') });
