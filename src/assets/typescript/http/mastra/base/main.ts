import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime';
import { Agent } from '@mastra/core/agent';
import { loadModel } from './model/load.js';

const SYSTEM_PROMPT = `You are a helpful assistant.`;

let cachedAgent: Agent | null = null;

async function getOrCreateAgent(): Promise<Agent> {
  if (!cachedAgent) {
    const model = await loadModel();
    cachedAgent = new Agent({
      id: '{{name}}',
      name: '{{name}}',
      instructions: SYSTEM_PROMPT,
      model,
    });
  }
  return cachedAgent;
}

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    async *process(payload: any, context: any) {
      const agent = await getOrCreateAgent();
      const stream = await agent.stream(payload.prompt ?? '');

      for await (const chunk of stream.fullStream) {
        if (chunk.type === 'text-delta') {
          yield { data: chunk.payload.text };
        }
      }
    },
  },
});

app.run({ port: parseInt(process.env.PORT ?? '8080') });
