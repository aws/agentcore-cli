import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime';
import { Agent, tool, type ToolList } from '@strands-agents/sdk';
import { z } from 'zod';
import { loadModel } from './model/load.js';
import { getOrCreateMemoryManager } from './memory/memory.js';

// Define a collection of tools used by the model
const tools: ToolList = [];

// Define a simple function tool — the Zod schema gives us type inference and runtime validation for free
const addNumbers = tool({
  name: 'add_numbers',
  description: 'Return the sum of two numbers',
  inputSchema: z.object({
    a: z.number(),
    b: z.number(),
  }),
  callback: async ({ a, b }) => a + b,
});
tools.push(addNumbers);

const SYSTEM_PROMPT = `
You are a helpful assistant. Use tools when appropriate.
`;

const requestSchema = z.object({
  prompt: z.string().default(''),
  actorId: z.string().default('default').transform((actorId) => actorId || 'default'),
});

const agentCache = new Map<string, Agent>();

async function getOrCreateAgent(sessionId: string, actorId: string): Promise<Agent> {
  const key = `${actorId}:${sessionId}`;
  let agent = agentCache.get(key);
  if (agent) return agent;

  const model = await loadModel();
  agent = new Agent({
    model,
    systemPrompt: SYSTEM_PROMPT,
    tools,
    memoryManager: getOrCreateMemoryManager(sessionId, actorId) ?? undefined,
  });
  agentCache.set(key, agent);
  return agent;
}

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    requestSchema,
    async *process(payload, context) {
      const sessionId = context?.sessionId ?? 'default-session';
      const actorId = payload.actorId;
      const agent = await getOrCreateAgent(sessionId, actorId);

      try {
        for await (const event of agent.stream(payload.prompt)) {
          if (
            event.type === 'modelStreamUpdateEvent' &&
            event.event?.type === 'modelContentBlockDeltaEvent' &&
            event.event.delta?.type === 'textDelta'
          ) {
            yield { data: event.event.delta.text };
          }
        }
      } finally {
        // Drain in-flight createEvent calls before the runtime can reclaim
        // the session microVM. flush() is the durability mechanism — without
        // it, an idle reclamation can lose the tail of the conversation.
        await agent.memoryManager?.flush();
      }
    },
  },
});

app.run({ port: parseInt(process.env.PORT ?? '8080') });
