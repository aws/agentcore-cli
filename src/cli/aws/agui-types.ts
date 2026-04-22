/**
 * TypeScript type definitions for AG-UI protocol events.
 * AG-UI is an event-based protocol for agent-to-user interaction.
 *
 * Events are streamed as SSE with type-in-JSON format:
 *   data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"msg-1","delta":"Hello"}\n\n
 *
 * @see https://docs.ag-ui.com/concepts/events
 */

// ============================================================================
// Event Type Enum
// ============================================================================

export enum AguiEventType {
  // Lifecycle
  RUN_STARTED = 'RUN_STARTED',
  RUN_FINISHED = 'RUN_FINISHED',
  RUN_ERROR = 'RUN_ERROR',
  STEP_STARTED = 'STEP_STARTED',
  STEP_FINISHED = 'STEP_FINISHED',

  // Text Message (streaming triplet)
  TEXT_MESSAGE_START = 'TEXT_MESSAGE_START',
  TEXT_MESSAGE_CONTENT = 'TEXT_MESSAGE_CONTENT',
  TEXT_MESSAGE_END = 'TEXT_MESSAGE_END',
  TEXT_MESSAGE_CHUNK = 'TEXT_MESSAGE_CHUNK',

  // Tool Call
  TOOL_CALL_START = 'TOOL_CALL_START',
  TOOL_CALL_ARGS = 'TOOL_CALL_ARGS',
  TOOL_CALL_END = 'TOOL_CALL_END',
  TOOL_CALL_RESULT = 'TOOL_CALL_RESULT',
  TOOL_CALL_CHUNK = 'TOOL_CALL_CHUNK',

  // State Management
  STATE_SNAPSHOT = 'STATE_SNAPSHOT',
  STATE_DELTA = 'STATE_DELTA',
  MESSAGES_SNAPSHOT = 'MESSAGES_SNAPSHOT',

  // Activity
  ACTIVITY_SNAPSHOT = 'ACTIVITY_SNAPSHOT',
  ACTIVITY_DELTA = 'ACTIVITY_DELTA',

  // Reasoning
  REASONING_START = 'REASONING_START',
  REASONING_MESSAGE_START = 'REASONING_MESSAGE_START',
  REASONING_MESSAGE_CONTENT = 'REASONING_MESSAGE_CONTENT',
  REASONING_MESSAGE_END = 'REASONING_MESSAGE_END',
  REASONING_END = 'REASONING_END',
  REASONING_ENCRYPTED_VALUE = 'REASONING_ENCRYPTED_VALUE',

  // Special
  RAW = 'RAW',
  CUSTOM = 'CUSTOM',
  META_EVENT = 'META_EVENT',
}

// ============================================================================
// Error Codes
// ============================================================================

export enum AguiErrorCode {
  AGENT_ERROR = 'AGENT_ERROR',
  UNAUTHORIZED = 'UNAUTHORIZED',
  ACCESS_DENIED = 'ACCESS_DENIED',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
}

// ============================================================================
// Base Event
// ============================================================================

export interface AguiBaseEvent {
  type: AguiEventType;
  timestamp?: number;
  rawEvent?: unknown;
}

// ============================================================================
// Lifecycle Events
// ============================================================================

export interface AguiRunStarted extends AguiBaseEvent {
  type: AguiEventType.RUN_STARTED;
  threadId: string;
  runId: string;
  parentRunId?: string;
}

export interface AguiRunFinished extends AguiBaseEvent {
  type: AguiEventType.RUN_FINISHED;
  threadId: string;
  runId: string;
  result?: unknown;
}

export interface AguiRunError extends AguiBaseEvent {
  type: AguiEventType.RUN_ERROR;
  message: string;
  code?: string;
}

export interface AguiStepStarted extends AguiBaseEvent {
  type: AguiEventType.STEP_STARTED;
  stepName: string;
}

export interface AguiStepFinished extends AguiBaseEvent {
  type: AguiEventType.STEP_FINISHED;
  stepName: string;
}

// ============================================================================
// Text Message Events
// ============================================================================

export interface AguiTextMessageStart extends AguiBaseEvent {
  type: AguiEventType.TEXT_MESSAGE_START;
  messageId: string;
  role: string;
}

export interface AguiTextMessageContent extends AguiBaseEvent {
  type: AguiEventType.TEXT_MESSAGE_CONTENT;
  messageId: string;
  delta: string;
}

export interface AguiTextMessageEnd extends AguiBaseEvent {
  type: AguiEventType.TEXT_MESSAGE_END;
  messageId: string;
}

// ============================================================================
// Tool Call Events
// ============================================================================

export interface AguiToolCallStart extends AguiBaseEvent {
  type: AguiEventType.TOOL_CALL_START;
  toolCallId: string;
  toolCallName: string;
  parentMessageId?: string;
}

export interface AguiToolCallArgs extends AguiBaseEvent {
  type: AguiEventType.TOOL_CALL_ARGS;
  toolCallId: string;
  delta: string;
}

export interface AguiToolCallEnd extends AguiBaseEvent {
  type: AguiEventType.TOOL_CALL_END;
  toolCallId: string;
}

export interface AguiToolCallResult extends AguiBaseEvent {
  type: AguiEventType.TOOL_CALL_RESULT;
  messageId: string;
  toolCallId: string;
  content: unknown;
  role?: string;
}

// ============================================================================
// State Management Events
// ============================================================================

export interface AguiStateSnapshot extends AguiBaseEvent {
  type: AguiEventType.STATE_SNAPSHOT;
  snapshot: Record<string, unknown>;
}

export interface AguiStateDelta extends AguiBaseEvent {
  type: AguiEventType.STATE_DELTA;
  delta: { op: string; path: string; value?: unknown }[];
}

export interface AguiMessagesSnapshot extends AguiBaseEvent {
  type: AguiEventType.MESSAGES_SNAPSHOT;
  messages: unknown[];
}

// ============================================================================
// Activity Events
// ============================================================================

export interface AguiActivitySnapshot extends AguiBaseEvent {
  type: AguiEventType.ACTIVITY_SNAPSHOT;
  messageId: string;
  activityType: string;
  content: Record<string, unknown>;
  replace?: boolean;
}

export interface AguiActivityDelta extends AguiBaseEvent {
  type: AguiEventType.ACTIVITY_DELTA;
  messageId: string;
  activityType: string;
  patch: { op: string; path: string; value?: unknown }[];
}

// ============================================================================
// Reasoning Events
// ============================================================================

export interface AguiReasoningStart extends AguiBaseEvent {
  type: AguiEventType.REASONING_START;
  messageId: string;
}

export interface AguiReasoningMessageStart extends AguiBaseEvent {
  type: AguiEventType.REASONING_MESSAGE_START;
  messageId: string;
  role: string;
}

export interface AguiReasoningMessageContent extends AguiBaseEvent {
  type: AguiEventType.REASONING_MESSAGE_CONTENT;
  messageId: string;
  delta: string;
}

export interface AguiReasoningMessageEnd extends AguiBaseEvent {
  type: AguiEventType.REASONING_MESSAGE_END;
  messageId: string;
}

export interface AguiReasoningEnd extends AguiBaseEvent {
  type: AguiEventType.REASONING_END;
  messageId: string;
}

// ============================================================================
// Additional Text / Tool Chunk Events
// ============================================================================

export interface AguiTextMessageChunk extends AguiBaseEvent {
  type: AguiEventType.TEXT_MESSAGE_CHUNK;
  messageId: string;
  role?: string;
  delta?: string;
  content?: string;
}

export interface AguiToolCallChunk extends AguiBaseEvent {
  type: AguiEventType.TOOL_CALL_CHUNK;
  toolCallId: string;
  delta?: string;
}

// ============================================================================
// Additional Reasoning Events
// ============================================================================

export interface AguiReasoningEncryptedValue extends AguiBaseEvent {
  type: AguiEventType.REASONING_ENCRYPTED_VALUE;
  messageId: string;
  data: string;
}

// ============================================================================
// Special Events
// ============================================================================

export interface AguiRawEvent extends AguiBaseEvent {
  type: AguiEventType.RAW;
  event: unknown;
  source?: string;
}

export interface AguiCustomEvent extends AguiBaseEvent {
  type: AguiEventType.CUSTOM;
  name: string;
  value: unknown;
}

export interface AguiMetaEvent extends AguiBaseEvent {
  type: AguiEventType.META_EVENT;
  name: string;
  value: unknown;
}

// ============================================================================
// Union type of all known events
// ============================================================================

export type AguiEvent =
  | AguiRunStarted
  | AguiRunFinished
  | AguiRunError
  | AguiStepStarted
  | AguiStepFinished
  | AguiTextMessageStart
  | AguiTextMessageContent
  | AguiTextMessageEnd
  | AguiTextMessageChunk
  | AguiToolCallStart
  | AguiToolCallArgs
  | AguiToolCallEnd
  | AguiToolCallResult
  | AguiToolCallChunk
  | AguiStateSnapshot
  | AguiStateDelta
  | AguiMessagesSnapshot
  | AguiActivitySnapshot
  | AguiActivityDelta
  | AguiReasoningStart
  | AguiReasoningMessageStart
  | AguiReasoningMessageContent
  | AguiReasoningMessageEnd
  | AguiReasoningEnd
  | AguiReasoningEncryptedValue
  | AguiRawEvent
  | AguiCustomEvent
  | AguiMetaEvent;

// ============================================================================
// RunAgentInput (request body for AGUI invocations)
// ============================================================================

export interface AguiMessage {
  id: string;
  role: string;
  content: string | unknown[];
  name?: string;
  toolCallId?: string;
}

export interface AguiTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AguiContext {
  description: string;
  value: string;
}

export interface AguiRunInput {
  threadId: string;
  runId: string;
  messages: AguiMessage[];
  tools?: AguiTool[];
  context?: AguiContext[];
  state?: Record<string, unknown>;
  forwardedProps?: Record<string, unknown>;
}

// ============================================================================
// Parser
// ============================================================================

/**
 * Parse a single SSE data line into a typed AGUI event.
 * Expects type-in-JSON format: data: {"type":"TEXT_MESSAGE_CONTENT","delta":"Hello"}
 * Returns null for non-data lines, empty lines, or malformed payloads.
 */
export function parseAguiEvent(line: string): AguiEvent | null {
  if (!line.startsWith('data: ')) {
    return null;
  }

  const jsonStr = line.slice(6).trim();
  if (!jsonStr) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(jsonStr);
    if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) {
      return null;
    }

    const event = parsed as Record<string, unknown>;
    const type = event.type as string;

    // Validate the type is a known AguiEventType
    if (!Object.values(AguiEventType).includes(type as AguiEventType)) {
      // Return as a base event for forward compatibility with unknown types
      return { type: type as AguiEventType, ...event } as unknown as AguiEvent;
    }

    return event as unknown as AguiEvent;
  } catch {
    return null;
  }
}

/**
 * Construct a minimal AguiRunInput from a user prompt string.
 * Generates fresh threadId and runId for single-turn invocations.
 */
export function buildAguiRunInput(prompt: string, threadId?: string, runId?: string): AguiRunInput {
  return {
    threadId: threadId ?? crypto.randomUUID(),
    runId: runId ?? crypto.randomUUID(),
    messages: [{ id: crypto.randomUUID(), role: 'user', content: prompt }],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  };
}
