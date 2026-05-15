import { startOtelCollector } from '../collector.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock node:http createServer so tests don't bind real sockets.
// The mock server immediately calls the listen callback (port available).
// ---------------------------------------------------------------------------

const { mockListen, mockClose, mockOn } = vi.hoisted(() => {
  const mockListen = vi.fn((_port: number, _host: string, cb: () => void) => {
    queueMicrotask(cb);
  });
  const mockClose = vi.fn();
  const mockOn = vi.fn();
  return { mockListen, mockClose, mockOn };
});

vi.mock('node:http', async importOriginal => {
  const actual = await importOriginal<typeof import('node:http')>();
  return {
    ...actual,
    createServer: vi.fn(() => ({
      listen: mockListen,
      close: mockClose,
      on: mockOn,
    })),
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// startOtelCollector — without custom endpoint (default behaviour)
// ---------------------------------------------------------------------------

describe('startOtelCollector', () => {
  describe('without custom endpoint (default behaviour)', () => {
    it('returns a defined collector instance', async () => {
      const { collector } = await startOtelCollector('/tmp/traces');

      expect(collector).toBeDefined();
    });

    it('sets OTEL_EXPORTER_OTLP_ENDPOINT to a local 127.0.0.1 address', async () => {
      const { otelEnvVars } = await startOtelCollector('/tmp/traces');

      expect(otelEnvVars.OTEL_EXPORTER_OTLP_ENDPOINT).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    });

    it('sets all required OTEL env vars', async () => {
      const { otelEnvVars } = await startOtelCollector('/tmp/traces');

      expect(otelEnvVars.OTEL_EXPORTER_OTLP_PROTOCOL).toBe('http/protobuf');
      expect(otelEnvVars.OTEL_METRICS_EXPORTER).toBe('none');
      expect(otelEnvVars.AGENT_OBSERVABILITY_ENABLED).toBe('true');
      expect(otelEnvVars.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT).toBe('true');
      expect(otelEnvVars.OTEL_PYTHON_LOGGING_AUTO_INSTRUMENTATION_ENABLED).toBe('true');
    });

    it('starts the HTTP server (binds a port)', async () => {
      await startOtelCollector('/tmp/traces');

      expect(mockListen).toHaveBeenCalledOnce();
    });
  });

  // ---------------------------------------------------------------------------
  // startOtelCollector — with custom endpoint
  // ---------------------------------------------------------------------------

  describe('with custom endpoint', () => {
    const CUSTOM_ENDPOINT = 'http://localhost:5388/otel/default';

    it('returns collector as undefined', async () => {
      const { collector } = await startOtelCollector('/tmp/traces', CUSTOM_ENDPOINT);

      expect(collector).toBeUndefined();
    });

    it('does NOT start a local HTTP server', async () => {
      await startOtelCollector('/tmp/traces', CUSTOM_ENDPOINT);

      expect(mockListen).not.toHaveBeenCalled();
    });

    it('sets OTEL_EXPORTER_OTLP_ENDPOINT to the custom endpoint', async () => {
      const { otelEnvVars } = await startOtelCollector('/tmp/traces', CUSTOM_ENDPOINT);

      expect(otelEnvVars.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(CUSTOM_ENDPOINT);
    });

    it('does not set a local 127.0.0.1 address as the endpoint', async () => {
      const { otelEnvVars } = await startOtelCollector('/tmp/traces', CUSTOM_ENDPOINT);

      expect(otelEnvVars.OTEL_EXPORTER_OTLP_ENDPOINT).not.toMatch(/127\.0\.0\.1/);
    });

    it('still sets all other required OTEL env vars', async () => {
      const { otelEnvVars } = await startOtelCollector('/tmp/traces', CUSTOM_ENDPOINT);

      expect(otelEnvVars.OTEL_EXPORTER_OTLP_PROTOCOL).toBe('http/protobuf');
      expect(otelEnvVars.OTEL_METRICS_EXPORTER).toBe('none');
      expect(otelEnvVars.AGENT_OBSERVABILITY_ENABLED).toBe('true');
      expect(otelEnvVars.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT).toBe('true');
      expect(otelEnvVars.OTEL_PYTHON_LOGGING_AUTO_INSTRUMENTATION_ENABLED).toBe('true');
    });

    it('works with a trailing-path endpoint URL', async () => {
      const endpoint = 'http://my-collector.internal:4317/v1/traces';
      const { otelEnvVars } = await startOtelCollector('/tmp/traces', endpoint);

      expect(otelEnvVars.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(endpoint);
    });
  });
});
