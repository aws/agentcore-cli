import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime';
import { streamText, type ModelMessage } from 'ai';
import { loadModel } from './model/load.js';

const SYSTEM_PROMPT = `You are a helpful assistant.`;

const HISTORY_LIMIT = 128;

// Keeps one message history per sessionId so each session remembers its own
// turns (best-effort; resets on cold start). A Map preserves insertion order,
// so it doubles as an LRU bounded to 128 sessions — a local dev process serving
// many sessions cannot leak history between them or grow without bound. On
// AgentCore Runtime each microVM serves a single session, so this holds one
// entry. For durable history, persist messages to an external store.
const histories = new Map<string, ModelMessage[]>();

function getHistory(sessionId: string): ModelMessage[] {
  const existing = histories.get(sessionId);
  if (existing) {
    histories.delete(sessionId);
    histories.set(sessionId, existing);
    return existing;
  }
  if (histories.size >= HISTORY_LIMIT) {
    const oldest = histories.keys().next().value;
    if (oldest !== undefined) histories.delete(oldest);
  }
  const fresh: ModelMessage[] = [];
  histories.set(sessionId, fresh);
  return fresh;
}

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    async *process(payload: any, context: any) {
      const sessionId = context?.sessionId ?? 'default-session';
      const messages = getHistory(sessionId);
      messages.push({ role: 'user', content: payload.prompt ?? '' });

      const model = await loadModel();
      const result = streamText({
        model,
        system: SYSTEM_PROMPT,
        messages,
      });

      let assistant = '';
      for await (const chunk of result.textStream) {
        assistant += chunk;
        yield { data: chunk };
      }
      messages.push({ role: 'assistant', content: assistant });
    },
  },
});

app.run({ port: parseInt(process.env.PORT ?? '8080') });
