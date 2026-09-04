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

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    requestSchema,
    async *process(payload) {
      const result = streamText({
        model: bedrock('global.anthropic.claude-sonnet-4-5-20250929-v1:0'),
        system: SYSTEM_PROMPT,
        prompt: payload.prompt,
      });

      for await (const chunk of result.textStream) {
        yield { data: chunk };
      }
    },
  },
});

app.run({ port: parseInt(process.env.PORT ?? '8080') });
