import { startOtelCollector } from '../otel';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

describe('startOtelCollector', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('uses built-in collector endpoint when no external endpoint is set', async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const { collector, otelEnvVars } = await startOtelCollector(join(tmpdir(), 'otel-test'));
    try {
      expect(otelEnvVars.OTEL_EXPORTER_OTLP_ENDPOINT).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      collector.stop();
    }
  });

  it('uses external endpoint when OTEL_EXPORTER_OTLP_ENDPOINT is set', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://my-collector:4318';
    const { collector, otelEnvVars } = await startOtelCollector(join(tmpdir(), 'otel-test'));
    try {
      expect(otelEnvVars.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://my-collector:4318');
    } finally {
      collector.stop();
    }
  });
});
