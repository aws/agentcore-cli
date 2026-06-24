import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime';
import { Agent, McpClient, tool, type ToolList } from '@strands-agents/sdk';
import { z } from 'zod';
import { loadModel } from './model/load.js';
import { getStreamableHttpMcpClient } from './mcp_client/client.js';
{{#if hasMemory}}
import { getActorId, getOrCreateMemoryManager } from './memory/memory.js';
{{/if}}

// Define a collection of MCP clients (filter out anything that failed to initialize)
const mcpClients: McpClient[] = [getStreamableHttpMcpClient()].filter(
  (client): client is McpClient => Boolean(client)
);

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

// Add MCP clients to tools
tools.push(...mcpClients);

const SYSTEM_PROMPT = `
You are a helpful assistant. Use tools when appropriate.
`;

{{#if hasMemory}}
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
{{else}}
let cachedAgent: Agent | null = null;

async function getOrCreateAgent(): Promise<Agent> {
  if (!cachedAgent) {
    const model = await loadModel();
    cachedAgent = new Agent({
      model,
      systemPrompt: SYSTEM_PROMPT,
      tools,
    });
  }
  return cachedAgent;
}
{{/if}}

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    async *process(payload: any, context: any) {
      {{#if hasMemory}}
      const sessionId = context?.sessionId ?? 'default-session';
      const actorId = getActorId(payload, context);
      const agent = await getOrCreateAgent(sessionId, actorId);
      {{else}}
      const agent = await getOrCreateAgent();
      {{/if}}

      {{#if hasMemory}}
      try {
        for await (const event of agent.stream(payload.prompt ?? '')) {
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
      {{else}}
      for await (const event of agent.stream(payload.prompt ?? '')) {
        if (
          event.type === 'modelStreamUpdateEvent' &&
          event.event?.type === 'modelContentBlockDeltaEvent' &&
          event.event.delta?.type === 'textDelta'
        ) {
          yield { data: event.event.delta.text };
        }
      }
      {{/if}}
    },
  },
});

app.run({ port: parseInt(process.env.PORT ?? '8080') });
