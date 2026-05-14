/* eslint-disable @typescript-eslint/require-await */
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
    await withCommandRunTelemetry('update', { check_only: true }, async () => ({ success: true }));

    expect(sink.metrics).toHaveLength(1);
    expect(sink.metrics[0]!.metric).toBe('cli.command_run');
    expect(sink.metrics[0]!.attrs).toMatchObject({
      command_group: 'update',
      command: 'update',
      exit_reason: 'success',
      check_only: 'true',
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

  it('classifies PackagingError subclasses', async () => {
    class MissingDependencyError extends Error {
      constructor() {
        super('missing dep');
        this.name = 'MissingDependencyError';
      }
    }

    await withCommandRunTelemetry('deploy', {} as never, async () => ({
      success: false as const,
      error: new MissingDependencyError(),
    }));

    expect(sink.metrics[0]!.attrs).toMatchObject({
      error_name: 'PackagingError',
      is_user_error: 'false',
    });
  });

  it('marks credential errors as user errors', async () => {
    class AwsCredentialsError extends Error {
      constructor() {
        super('creds expired');
        this.name = 'AwsCredentialsError';
      }
    }

    await withCommandRunTelemetry('invoke', {} as never, async () => ({
      success: false as const,
      error: new AwsCredentialsError(),
    }));

    expect(sink.metrics[0]!.attrs).toMatchObject({
      error_name: 'CredentialsError',
      is_user_error: 'true',
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
    await withCommandRunTelemetry('update', { check_only: true }, async () => ({ success: true }));

    expect(sink.metrics[0]!.attrs.check_only).toBe('true');
  });

  it('defaults invalid attrs to unknown while preserving valid ones', async () => {
    await withCommandRunTelemetry(
      'create',
      {
        language: 'rust' as never,
        framework: 'strands',
        model_provider: 'bedrock',
        memory: 'shortterm',
        protocol: 'mcp',
        build: 'codezip',
        agent_type: 'create',
        network_mode: 'public',
        has_agent: true,
      },
      async () => ({ success: true })
    );

    expect(sink.metrics).toHaveLength(1);
    expect(sink.metrics[0]!.attrs.language).toBe('unknown');
    expect(sink.metrics[0]!.attrs.framework).toBe('strands');
  });

  it('records fallbackAttrs on failure', async () => {
    await withCommandRunTelemetry(
      'create',
      {
        language: 'python',
        framework: 'strands',
        model_provider: 'bedrock',
        memory: 'none',
        protocol: 'http',
        build: 'codezip',
        agent_type: 'create',
        network_mode: 'public',
        has_agent: true,
      },
      async () => ({ success: false as const, error: new Error('validation failed') })
    );

    expect(sink.metrics).toHaveLength(1);
    expect(sink.metrics[0]!.attrs).toMatchObject({
      exit_reason: 'failure',
      error_name: 'UnknownError',
      language: 'python',
      framework: 'strands',
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
});
