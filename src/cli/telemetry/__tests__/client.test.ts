/* eslint-disable @typescript-eslint/require-await */
import { CANCELLED, TelemetryClient } from '../client';
import { InMemorySink } from '../sinks/in-memory-sink';
import { describe, expect, it } from 'vitest';

describe('TelemetryClient', () => {
  describe('withCommandRun', () => {
    it('records success with returned attrs', async () => {
      const sink = new InMemorySink();
      const client = new TelemetryClient(sink);

      await client.withCommandRun('update', async () => ({ check_only: true }));

      expect(sink.metrics).toHaveLength(1);
      expect(sink.metrics[0]!.attrs).toMatchObject({
        command_group: 'update',
        command: 'update',
        exit_reason: 'success',
        check_only: 'true',
      });
    });

    it('accepts sync callbacks', async () => {
      const sink = new InMemorySink();
      const client = new TelemetryClient(sink);

      await client.withCommandRun('telemetry.disable', () => ({}));

      expect(sink.metrics).toHaveLength(1);
      expect(sink.metrics[0]!.attrs).toMatchObject({ exit_reason: 'success' });
    });

    it('records failure and re-throws on error', async () => {
      const sink = new InMemorySink();
      const client = new TelemetryClient(sink);

      await expect(
        client.withCommandRun('deploy', async () => {
          throw new Error('boom');
        })
      ).rejects.toThrow('boom');

      expect(sink.metrics).toHaveLength(1);
      expect(sink.metrics[0]!.attrs).toMatchObject({
        command_group: 'deploy',
        exit_reason: 'failure',
        error_name: 'UnknownError',
      });
    });

    it('classifies PackagingError subclasses', async () => {
      const sink = new InMemorySink();
      const client = new TelemetryClient(sink);

      class MissingDependencyError extends Error {
        constructor() {
          super('missing dep');
          this.name = 'MissingDependencyError';
        }
      }

      await expect(
        client.withCommandRun('deploy', async () => {
          throw new MissingDependencyError();
        })
      ).rejects.toThrow();

      expect(sink.metrics[0]!.attrs).toMatchObject({
        error_name: 'PackagingError',
        is_user_error: 'false',
      });
    });

    it('marks credential errors as user errors', async () => {
      const sink = new InMemorySink();
      const client = new TelemetryClient(sink);

      class AwsCredentialsError extends Error {
        constructor() {
          super('creds expired');
          this.name = 'AwsCredentialsError';
        }
      }

      await expect(
        client.withCommandRun('invoke', async () => {
          throw new AwsCredentialsError();
        })
      ).rejects.toThrow();

      expect(sink.metrics[0]!.attrs).toMatchObject({
        error_name: 'CredentialsError',
        is_user_error: 'true',
      });
    });

    it('records duration as a non-negative integer', async () => {
      const sink = new InMemorySink();
      const client = new TelemetryClient(sink);

      await client.withCommandRun('telemetry.disable', async () => {
        await new Promise(r => globalThis.setTimeout(r, 5));
        return {};
      });

      expect(sink.metrics[0]!.value).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(sink.metrics[0]!.value)).toBe(true);
    });

    it('converts boolean attrs to strings', async () => {
      const sink = new InMemorySink();
      const client = new TelemetryClient(sink);

      await client.withCommandRun('update', async () => ({ check_only: true }));

      expect(sink.metrics[0]!.attrs.check_only).toBe('true');
    });

    it('silently drops invalid success payloads', async () => {
      const sink = new InMemorySink();
      const client = new TelemetryClient(sink);

      // Missing required attrs for 'create' — should silently drop
      await client.withCommandRun(
        'create',
        // @ts-expect-error — intentionally incomplete
        async () => ({ language: 'python' })
      );

      expect(sink.metrics).toHaveLength(0);
    });

    it('records cancel when callback returns CANCELLED', async () => {
      const sink = new InMemorySink();
      const client = new TelemetryClient(sink);

      await client.withCommandRun('deploy', () => CANCELLED);

      expect(sink.metrics).toHaveLength(1);
      expect(sink.metrics[0]!.attrs).toMatchObject({
        command_group: 'deploy',
        exit_reason: 'cancel',
      });
    });
  });
});
