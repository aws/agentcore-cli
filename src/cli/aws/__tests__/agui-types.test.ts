import {
  type AguiCustomEvent,
  AguiErrorCode,
  AguiEventType,
  type AguiReasoningMessageContent,
  type AguiRunError,
  type AguiRunFinished,
  type AguiRunStarted,
  type AguiStateDelta,
  type AguiStateSnapshot,
  type AguiStepStarted,
  type AguiTextMessageContent,
  type AguiToolCallArgs,
  type AguiToolCallEnd,
  type AguiToolCallResult,
  type AguiToolCallStart,
  buildAguiRunInput,
  parseAguiEvent,
} from '../agui-types';
import { describe, expect, it } from 'vitest';

describe('AguiEventType enum', () => {
  it('contains all expected event types', () => {
    // Verify total count to catch accidental additions/removals
    const enumValues = Object.values(AguiEventType);
    expect(enumValues).toHaveLength(28);

    // Spot-check representative values from each category
    expect(AguiEventType.RUN_STARTED).toBe('RUN_STARTED');
    expect(AguiEventType.RUN_FINISHED).toBe('RUN_FINISHED');
    expect(AguiEventType.RUN_ERROR).toBe('RUN_ERROR');
    expect(AguiEventType.STEP_STARTED).toBe('STEP_STARTED');
    expect(AguiEventType.STEP_FINISHED).toBe('STEP_FINISHED');
    expect(AguiEventType.TEXT_MESSAGE_START).toBe('TEXT_MESSAGE_START');
    expect(AguiEventType.TEXT_MESSAGE_CONTENT).toBe('TEXT_MESSAGE_CONTENT');
    expect(AguiEventType.TEXT_MESSAGE_END).toBe('TEXT_MESSAGE_END');
    expect(AguiEventType.TEXT_MESSAGE_CHUNK).toBe('TEXT_MESSAGE_CHUNK');
    expect(AguiEventType.TOOL_CALL_START).toBe('TOOL_CALL_START');
    expect(AguiEventType.TOOL_CALL_ARGS).toBe('TOOL_CALL_ARGS');
    expect(AguiEventType.TOOL_CALL_END).toBe('TOOL_CALL_END');
    expect(AguiEventType.TOOL_CALL_RESULT).toBe('TOOL_CALL_RESULT');
    expect(AguiEventType.TOOL_CALL_CHUNK).toBe('TOOL_CALL_CHUNK');
    expect(AguiEventType.STATE_SNAPSHOT).toBe('STATE_SNAPSHOT');
    expect(AguiEventType.STATE_DELTA).toBe('STATE_DELTA');
    expect(AguiEventType.MESSAGES_SNAPSHOT).toBe('MESSAGES_SNAPSHOT');
    expect(AguiEventType.ACTIVITY_SNAPSHOT).toBe('ACTIVITY_SNAPSHOT');
    expect(AguiEventType.ACTIVITY_DELTA).toBe('ACTIVITY_DELTA');
    expect(AguiEventType.REASONING_START).toBe('REASONING_START');
    expect(AguiEventType.REASONING_MESSAGE_START).toBe('REASONING_MESSAGE_START');
    expect(AguiEventType.REASONING_MESSAGE_CONTENT).toBe('REASONING_MESSAGE_CONTENT');
    expect(AguiEventType.REASONING_MESSAGE_END).toBe('REASONING_MESSAGE_END');
    expect(AguiEventType.REASONING_END).toBe('REASONING_END');
    expect(AguiEventType.REASONING_ENCRYPTED_VALUE).toBe('REASONING_ENCRYPTED_VALUE');
    expect(AguiEventType.RAW).toBe('RAW');
    expect(AguiEventType.CUSTOM).toBe('CUSTOM');
    expect(AguiEventType.META_EVENT).toBe('META_EVENT');
  });
});

describe('AguiErrorCode enum', () => {
  it('contains all expected error codes', () => {
    expect(AguiErrorCode.AGENT_ERROR).toBe('AGENT_ERROR');
    expect(AguiErrorCode.UNAUTHORIZED).toBe('UNAUTHORIZED');
    expect(AguiErrorCode.ACCESS_DENIED).toBe('ACCESS_DENIED');
    expect(AguiErrorCode.VALIDATION_ERROR).toBe('VALIDATION_ERROR');
    expect(AguiErrorCode.RATE_LIMIT_EXCEEDED).toBe('RATE_LIMIT_EXCEEDED');
  });
});

describe('parseAguiEvent', () => {
  describe('lifecycle events', () => {
    it('parses RUN_STARTED', () => {
      const event = parseAguiEvent('data: {"type":"RUN_STARTED","threadId":"t-1","runId":"r-1"}');
      expect(event).not.toBeNull();
      expect(event!.type).toBe(AguiEventType.RUN_STARTED);
      const started = event as AguiRunStarted;
      expect(started.threadId).toBe('t-1');
      expect(started.runId).toBe('r-1');
    });

    it('parses RUN_FINISHED', () => {
      const event = parseAguiEvent('data: {"type":"RUN_FINISHED","threadId":"t-1","runId":"r-1"}');
      expect(event).not.toBeNull();
      const finished = event as AguiRunFinished;
      expect(finished.type).toBe(AguiEventType.RUN_FINISHED);
      expect(finished.threadId).toBe('t-1');
    });

    it('parses RUN_ERROR', () => {
      const event = parseAguiEvent('data: {"type":"RUN_ERROR","message":"Agent failed","code":"AGENT_ERROR"}');
      expect(event).not.toBeNull();
      const error = event as AguiRunError;
      expect(error.type).toBe(AguiEventType.RUN_ERROR);
      expect(error.message).toBe('Agent failed');
      expect(error.code).toBe('AGENT_ERROR');
    });

    it('parses STEP_STARTED', () => {
      const event = parseAguiEvent('data: {"type":"STEP_STARTED","stepName":"chat_node"}');
      expect(event).not.toBeNull();
      const step = event as AguiStepStarted;
      expect(step.type).toBe(AguiEventType.STEP_STARTED);
      expect(step.stepName).toBe('chat_node');
    });
  });

  describe('text message events', () => {
    it('parses TEXT_MESSAGE_CONTENT with delta', () => {
      const event = parseAguiEvent('data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"msg-1","delta":"Hello"}');
      expect(event).not.toBeNull();
      const content = event as AguiTextMessageContent;
      expect(content.type).toBe(AguiEventType.TEXT_MESSAGE_CONTENT);
      expect(content.messageId).toBe('msg-1');
      expect(content.delta).toBe('Hello');
    });

    it('parses TEXT_MESSAGE_CONTENT with unicode', () => {
      const event = parseAguiEvent('data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"msg-1","delta":"Hello world!"}');
      expect(event).not.toBeNull();
      expect((event as AguiTextMessageContent).delta).toBe('Hello world!');
    });
  });

  describe('tool call events', () => {
    it('parses TOOL_CALL_START', () => {
      const event = parseAguiEvent(
        'data: {"type":"TOOL_CALL_START","toolCallId":"tc-1","toolCallName":"add_numbers","parentMessageId":"msg-1"}'
      );
      expect(event).not.toBeNull();
      const start = event as AguiToolCallStart;
      expect(start.type).toBe(AguiEventType.TOOL_CALL_START);
      expect(start.toolCallId).toBe('tc-1');
      expect(start.toolCallName).toBe('add_numbers');
      expect(start.parentMessageId).toBe('msg-1');
    });

    it('parses TOOL_CALL_ARGS', () => {
      const event = parseAguiEvent('data: {"type":"TOOL_CALL_ARGS","toolCallId":"tc-1","delta":"{\\"a\\": 1"}');
      expect(event).not.toBeNull();
      const args = event as AguiToolCallArgs;
      expect(args.type).toBe(AguiEventType.TOOL_CALL_ARGS);
      expect(args.toolCallId).toBe('tc-1');
      expect(args.delta).toBe('{"a": 1');
    });

    it('parses TOOL_CALL_END', () => {
      const event = parseAguiEvent('data: {"type":"TOOL_CALL_END","toolCallId":"tc-1"}');
      expect(event).not.toBeNull();
      const end = event as AguiToolCallEnd;
      expect(end.type).toBe(AguiEventType.TOOL_CALL_END);
      expect(end.toolCallId).toBe('tc-1');
    });

    it('parses TOOL_CALL_RESULT', () => {
      const event = parseAguiEvent(
        'data: {"type":"TOOL_CALL_RESULT","messageId":"msg-2","toolCallId":"tc-1","content":"42"}'
      );
      expect(event).not.toBeNull();
      const result = event as AguiToolCallResult;
      expect(result.type).toBe(AguiEventType.TOOL_CALL_RESULT);
      expect(result.toolCallId).toBe('tc-1');
      expect(result.content).toBe('42');
    });
  });

  describe('state events', () => {
    it('parses STATE_SNAPSHOT', () => {
      const event = parseAguiEvent('data: {"type":"STATE_SNAPSHOT","snapshot":{"count":5}}');
      expect(event).not.toBeNull();
      const snapshot = event as AguiStateSnapshot;
      expect(snapshot.type).toBe(AguiEventType.STATE_SNAPSHOT);
      expect(snapshot.snapshot).toEqual({ count: 5 });
    });

    it('parses STATE_DELTA', () => {
      const event = parseAguiEvent('data: {"type":"STATE_DELTA","delta":[{"op":"replace","path":"/count","value":6}]}');
      expect(event).not.toBeNull();
      const delta = event as AguiStateDelta;
      expect(delta.type).toBe(AguiEventType.STATE_DELTA);
      expect(delta.delta).toHaveLength(1);
      expect(delta.delta[0]!.op).toBe('replace');
    });
  });

  describe('reasoning events', () => {
    it('parses REASONING_MESSAGE_CONTENT', () => {
      const event = parseAguiEvent(
        'data: {"type":"REASONING_MESSAGE_CONTENT","messageId":"msg-1","delta":"Let me think..."}'
      );
      expect(event).not.toBeNull();
      const reasoning = event as AguiReasoningMessageContent;
      expect(reasoning.type).toBe(AguiEventType.REASONING_MESSAGE_CONTENT);
      expect(reasoning.delta).toBe('Let me think...');
    });
  });

  describe('special events', () => {
    it('parses CUSTOM event', () => {
      const event = parseAguiEvent('data: {"type":"CUSTOM","name":"PredictState","value":{"key":"doc"}}');
      expect(event).not.toBeNull();
      const custom = event as AguiCustomEvent;
      expect(custom.type).toBe(AguiEventType.CUSTOM);
      expect(custom.name).toBe('PredictState');
      expect(custom.value).toEqual({ key: 'doc' });
    });
  });

  describe('error handling', () => {
    it('returns null for non-data lines', () => {
      expect(parseAguiEvent('event: TEXT_MESSAGE_CONTENT')).toBeNull();
      expect(parseAguiEvent('')).toBeNull();
      expect(parseAguiEvent('retry: 5000')).toBeNull();
    });

    it('returns null for empty data lines', () => {
      expect(parseAguiEvent('data: ')).toBeNull();
      expect(parseAguiEvent('data:  ')).toBeNull();
    });

    it('returns null for malformed JSON', () => {
      expect(parseAguiEvent('data: {not valid json}')).toBeNull();
    });

    it('returns null for JSON without type field', () => {
      expect(parseAguiEvent('data: {"delta":"hello"}')).toBeNull();
    });

    it('handles unknown event types gracefully', () => {
      const event = parseAguiEvent('data: {"type":"FUTURE_EVENT_TYPE","someField":"value"}');
      expect(event).not.toBeNull();
      expect(event!.type).toBe('FUTURE_EVENT_TYPE');
    });
  });
});

describe('buildAguiRunInput', () => {
  it('creates minimal input from prompt', () => {
    const input = buildAguiRunInput('Hello');
    expect(input.threadId).toBeDefined();
    expect(input.runId).toBeDefined();
    expect(input.messages).toHaveLength(1);
    expect(input.messages[0]!.role).toBe('user');
    expect(input.messages[0]!.content).toBe('Hello');
    expect(input.tools).toEqual([]);
    expect(input.context).toEqual([]);
    expect(input.state).toEqual({});
    expect(input.forwardedProps).toEqual({});
  });

  it('uses provided threadId and runId', () => {
    const input = buildAguiRunInput('Hello', 'my-thread', 'my-run');
    expect(input.threadId).toBe('my-thread');
    expect(input.runId).toBe('my-run');
  });

  it('generates unique IDs per call', () => {
    const a = buildAguiRunInput('Hello');
    const b = buildAguiRunInput('Hello');
    expect(a.threadId).not.toBe(b.threadId);
    expect(a.runId).not.toBe(b.runId);
  });
});
