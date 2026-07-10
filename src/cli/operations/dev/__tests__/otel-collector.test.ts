import { hasExternalOtelEndpoint } from '../otel';
import { afterEach, describe, expect, it } from 'vitest';

describe('hasExternalOtelEndpoint', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('returns false when no OTEL endpoint env vars are set', () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    expect(hasExternalOtelEndpoint()).toBe(false);
  });

  it('returns true when OTEL_EXPORTER_OTLP_ENDPOINT is set', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318';
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    expect(hasExternalOtelEndpoint()).toBe(true);
  });

  it('returns true when OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is set', () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'http://localhost:4318/v1/traces';
    expect(hasExternalOtelEndpoint()).toBe(true);
  });

  it('returns true when both are set', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318';
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'http://localhost:4318/v1/traces';
    expect(hasExternalOtelEndpoint()).toBe(true);
  });
});
