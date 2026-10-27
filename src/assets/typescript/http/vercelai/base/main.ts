import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime';
import { streamText, type ModelMessage } from 'ai';
import { z } from 'zod';
import { loadModel } from './model/load.js';

const SYSTEM_PROMPT = `You are a helpful assistant.`;

const requestSchema = z.object({
  prompt: z.string().default(''),
});

const HISTORY_LIMIT = 128;

// Emit OpenTelemetry spans for model calls (token usage, latency, GenAI
// attributes) when observability is enabled. ADOT registers a global tracer at
// startup that these spans flow to. Set here rather than relying on the ADOT
// Vercel-AI auto-instrumentation, which patches the `ai` module at import time:
// that never fires under CodeZip, where esbuild inlines `ai` into the bundle so
// there is no import to intercept. Toggling the SDK's own telemetry works
// regardless of bundling. Enabled whenever the runtime turns on observability.
const AI_TELEMETRY = { isEnabled: process.env.AGENT_OBSERVABILITY_ENABLED === 'true' };

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
    requestSchema,
    async *process(payload, context) {
      const sessionId = context?.sessionId ?? 'default-session';
      const history = getHistory(sessionId);
      const userMessage: ModelMessage = { role: 'user', content: payload.prompt };

      const model = await loadModel();
      const result = streamText({
        model,
        system: SYSTEM_PROMPT,
        messages: [...history, userMessage],
        experimental_telemetry: AI_TELEMETRY,
      });

      let assistant = '';
      for await (const chunk of result.textStream) {
        assistant += chunk;
        yield { data: chunk };
      }

      // Commit the exchange to history only after a non-empty reply. On a failed
      // or empty stream the turn is dropped instead of leaving a dangling user
      // (or empty assistant) message — consecutive same-role or empty-content
      // messages would otherwise be rejected on the next turn for this session.
      if (assistant.length > 0) {
        history.push(userMessage, { role: 'assistant', content: assistant });
      }
    },
  },
});

app.run({ port: parseInt(process.env.PORT ?? '8080') });
