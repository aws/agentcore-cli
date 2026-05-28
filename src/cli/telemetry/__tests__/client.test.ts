/* eslint-disable @typescript-eslint/require-await */
import { AccessDeniedError, DependencyCheckError } from '../../../lib/errors/types';
import { withCommandRunTelemetry } from '../cli-command-run';
import { TelemetryClient } from '../client';
import { TelemetryClientAccessor } from '../client-accessor';
import { InMemorySink } from '../sinks/in-memory-sink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let sink: InMemorySink;

beforeEach(() => {
  sink = new InMemorySink();
  vi.spyOn(TelemetryClientAccessor, 'get').mockResolvedValue(new TelemetryClient(sink));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('withCommandRunTelemetry', () => {
  it('records success with returned attrs', async () => {
    await withCommandRunTelemetry('update', { is_dry_run: true }, async () => ({ success: true }));

    expect(sink.metrics).toHaveLength(1);
    expect(sink.metrics[0]!.metric).toBe('cli.command_run');
    expect(sink.metrics[0]!.attrs).toMatchObject({
      command_group: 'update',
      command: 'update',
      exit_reason: 'success',
      is_dry_run: 'true',
    });
  });

  it('records failure when callback returns failure result', async () => {
    const result = await withCommandRunTelemetry('deploy', {} as never, async () => ({
      success: false as const,
      error: new Error('boom'),
    }));

    expect(result.success).toBe(false);
    expect(sink.metrics).toHaveLength(1);
    expect(sink.metrics[0]!.attrs).toMatchObject({
      command_group: 'deploy',
      exit_reason: 'failure',
      error_name: 'UnknownError',
    });
  });

  it('classifies DependencyCheckError correctly', async () => {
    await withCommandRunTelemetry('deploy', {} as never, async () => ({
      success: false as const,
      error: new DependencyCheckError(['missing docker']),
    }));

    expect(sink.metrics[0]!.attrs).toMatchObject({
      error_name: 'DependencyCheckError',
      error_source: 'user',
    });
  });

  it('marks credential errors as user errors', async () => {
    await withCommandRunTelemetry('invoke', {} as never, async () => ({
      success: false as const,
      error: new AccessDeniedError('creds expired'),
    }));

    expect(sink.metrics[0]!.attrs).toMatchObject({
      error_name: 'AccessDeniedError',
      error_source: 'user',
    });
  });

  it('records duration as a non-negative integer', async () => {
    await withCommandRunTelemetry('telemetry.disable', {}, async () => {
      await new Promise(r => globalThis.setTimeout(r, 5));
      return { success: true as const };
    });

    expect(sink.metrics[0]!.value).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(sink.metrics[0]!.value)).toBe(true);
  });

  it('converts boolean attrs to strings', async () => {
    await withCommandRunTelemetry('update', { is_dry_run: true }, async () => ({ success: true }));

    expect(sink.metrics[0]!.attrs.is_dry_run).toBe('true');
  });

  it('defaults invalid attrs to unknown while preserving valid ones', async () => {
    await withCommandRunTelemetry(
      'create',
      {
        agent_language: 'rust' as never,
        agent_framework: 'strands',
        model_provider: 'bedrock',
        memory_type: 'shortterm',
        agent_protocol: 'mcp',
        build_type: 'codezip',
        agent_source: 'create',
        network_mode: 'public',
        has_agent: true,
      },
      async () => ({ success: true })
    );

    expect(sink.metrics).toHaveLength(1);
    expect(sink.metrics[0]!.attrs.agent_language).toBe('unknown');
    expect(sink.metrics[0]!.attrs.agent_framework).toBe('strands');
  });

  it('records fallbackAttrs on failure', async () => {
    await withCommandRunTelemetry(
      'create',
      {
        agent_language: 'python',
        agent_framework: 'strands',
        model_provider: 'bedrock',
        memory_type: 'none',
        agent_protocol: 'http',
        build_type: 'codezip',
        agent_source: 'create',
        network_mode: 'public',
        has_agent: true,
      },
      async () => ({ success: false as const, error: new Error('validation failed') })
    );

    expect(sink.metrics).toHaveLength(1);
    expect(sink.metrics[0]!.attrs).toMatchObject({
      exit_reason: 'failure',
      error_name: 'UnknownError',
      agent_language: 'python',
      agent_framework: 'strands',
      model_provider: 'bedrock',
      has_agent: 'true',
    });
  });

  it('runs untracked when telemetry client is unavailable', async () => {
    vi.spyOn(TelemetryClientAccessor, 'get').mockRejectedValue(new Error('no client'));

    const result = await withCommandRunTelemetry('deploy', {} as never, async () => ({ success: true }));

    expect(result).toEqual({ success: true });
    expect(sink.metrics).toHaveLength(0);
  });

  it('records failure and returns error result when callback throws', async () => {
    type R = { success: true } | { success: false; error: Error };
    const result = await withCommandRunTelemetry<'telemetry.disable', R>(
      'telemetry.disable',
      {},
      async (): Promise<R> => {
        throw new Error('network timeout');
      }
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBe('network timeout');
    }
    expect(sink.metrics).toHaveLength(1);
    expect(sink.metrics[0]!.attrs).toMatchObject({
      command: 'telemetry.disable',
      exit_reason: 'failure',
      error_name: 'UnknownError',
    });
  });

  describe('AttributeRecorder', () => {
    it('recorder.set() overrides initial attributes on success', async () => {
      await withCommandRunTelemetry(
        'dev',
        {
          dev_action: 'server',
          ui_mode: 'terminal',
          has_stream: false,
          agent_protocol: 'http',
          invoke_count: 0,
        },
        async recorder => {
          recorder.set({
            dev_action: 'invoke',
            ui_mode: 'browser',
            has_stream: true,
            agent_protocol: 'a2a',
            invoke_count: 5,
          });
          return { success: true as const };
        }
      );

      expect(sink.metrics).toHaveLength(1);
      expect(sink.metrics[0]!.attrs).toMatchObject({
        dev_action: 'invoke',
        ui_mode: 'browser',
        has_stream: 'true',
        agent_protocol: 'a2a',
        invoke_count: 5,
      });
    });

    it('recorder.set() overrides initial attributes on failure result', async () => {
      await withCommandRunTelemetry(
        'dev',
        {
          dev_action: 'server',
          ui_mode: 'terminal',
          has_stream: false,
          agent_protocol: 'http',
          invoke_count: 0,
        },
        async recorder => {
          recorder.set({
            agent_protocol: 'mcp',
          });
          return { success: false as const, error: new Error('port in use') };
        }
      );

      expect(sink.metrics).toHaveLength(1);
      expect(sink.metrics[0]!.attrs).toMatchObject({
        exit_reason: 'failure',
        agent_protocol: 'mcp',
      });
    });

    it('uses initial attributes when recorder.set() is never called', async () => {
      await withCommandRunTelemetry(
        'dev',
        {
          dev_action: 'server',
          ui_mode: 'terminal',
          has_stream: false,
          agent_protocol: 'http',
          invoke_count: 0,
        },
        async () => ({ success: true as const })
      );

      expect(sink.metrics).toHaveLength(1);
      expect(sink.metrics[0]!.attrs).toMatchObject({
        agent_protocol: 'http',
        dev_action: 'server',
      });
    });

    it('partial recorder.set() merges with initial attributes preserving non-overlapping keys', async () => {
      await withCommandRunTelemetry(
        'dev',
        {
          dev_action: 'server',
          ui_mode: 'terminal',
          has_stream: false,
          agent_protocol: 'http',
          invoke_count: 0,
        },
        async recorder => {
          recorder.set({
            agent_protocol: 'mcp',
          });
          return { success: true as const };
        }
      );

      expect(sink.metrics).toHaveLength(1);
      expect(sink.metrics[0]!.attrs).toMatchObject({
        dev_action: 'server',
        ui_mode: 'terminal',
        has_stream: 'false',
        agent_protocol: 'mcp',
        invoke_count: 0,
      });
    });

    it('recorder.set() called before throw is preserved in telemetry', async () => {
      await withCommandRunTelemetry(
        'dev',
        {
          dev_action: 'server',
          ui_mode: 'terminal',
          has_stream: false,
          agent_protocol: 'http',
          invoke_count: 0,
        },
        async recorder => {
          recorder.set({ agent_protocol: 'a2a' });
          throw new Error('crash');
        }
      );

      expect(sink.metrics).toHaveLength(1);
      expect(sink.metrics[0]!.attrs).toMatchObject({
        exit_reason: 'failure',
        agent_protocol: 'a2a',
      });
    });
  });
});
