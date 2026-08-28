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

const requestSchema = z.object({
  prompt: z.string().default(''),
});

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
const AGENT_CACHE_LIMIT = 128;

// Reuses one Agent per sessionId so each session keeps its own in-process
// conversation history (best-effort; resets on cold start). A Map preserves
// insertion order, so it doubles as an LRU bounded to 128 sessions — a local
// dev process serving many sessions cannot leak history between them or grow
// without bound. On AgentCore Runtime each microVM serves a single session, so
// this holds one entry. For durable history, attach memory.
const agentCache = new Map<string, Agent>();

async function getOrCreateAgent(sessionId: string): Promise<Agent> {
  const existing = agentCache.get(sessionId);
  if (existing) {
    agentCache.delete(sessionId);
    agentCache.set(sessionId, existing);
    return existing;
  }
  if (agentCache.size >= AGENT_CACHE_LIMIT) {
    const oldest = agentCache.keys().next().value;
    if (oldest !== undefined) agentCache.delete(oldest);
  }
  const model = await loadModel();
  const agent = new Agent({
    model,
    systemPrompt: SYSTEM_PROMPT,
    tools,
  });
  agentCache.set(sessionId, agent);
  return agent;
}
{{/if}}

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    requestSchema,
    async *process(payload, context) {
      {{#if hasMemory}}
      const sessionId = context?.sessionId ?? 'default-session';
      const actorId = getActorId(payload, context);
      const agent = await getOrCreateAgent(sessionId, actorId);
      {{else}}
      const sessionId = context?.sessionId ?? 'default-session';
      const agent = await getOrCreateAgent(sessionId);
      {{/if}}

      {{#if hasMemory}}
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
      {{else}}
      // Snapshot history before streaming so a failed turn can be rolled back.
      // Agent.stream() appends the user message before invoking the model; on a
      // mid-stream error that user turn would otherwise linger in the cached
      // agent, and the next turn for this session would send consecutive user
      // messages (rejected by providers that require strict role alternation,
      // e.g. Anthropic). Restoring on error keeps the session reusable.
      const snapshot = agent.takeSnapshot({ include: ['messages'] });
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
      } catch (error) {
        agent.loadSnapshot(snapshot);
        throw error;
      }
      {{/if}}
    },
  },
});

app.run({ port: parseInt(process.env.PORT ?? '8080') });
