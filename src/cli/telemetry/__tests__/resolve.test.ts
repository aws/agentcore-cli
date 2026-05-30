import { TELEMETRY_ENDPOINT } from '../../constants';
import {
  resolveAuditEnabled,
  resolveTelemetryEndpoint,
  resolveTelemetryPreference,
  validateEndpointUrl,
} from '../config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('resolveTelemetryPreference', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.AGENTCORE_TELEMETRY_DISABLED;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('AGENTCORE_TELEMETRY_DISABLED env var', () => {
    it('disables telemetry for any non-false/non-0 value', async () => {
      for (const val of ['true', 'TRUE', '1', 'yes']) {
        process.env.AGENTCORE_TELEMETRY_DISABLED = val;

        const result = await resolveTelemetryPreference();

        expect(result).toMatchObject({ enabled: false, source: 'environment' });
        expect(result.envVar).toEqual({ name: 'AGENTCORE_TELEMETRY_DISABLED', value: val });
      }
    });

    it('enables telemetry when set to "false" or "0"', async () => {
      for (const val of ['false', '0']) {
        process.env.AGENTCORE_TELEMETRY_DISABLED = val;

        const result = await resolveTelemetryPreference();

        expect(result).toMatchObject({ enabled: true, source: 'environment' });
        expect(result.envVar).toEqual({ name: 'AGENTCORE_TELEMETRY_DISABLED', value: val });
      }
    });
  });

  describe('global config', () => {
    it('uses config when telemetry.enabled is false', async () => {
      const result = await resolveTelemetryPreference({ telemetry: { enabled: false } });

      expect(result).toEqual({ enabled: false, source: 'global-config' });
    });

    it('ignores non-boolean enabled values in config', async () => {
      // @ts-expect-error — intentionally invalid
      const result = await resolveTelemetryPreference({ telemetry: { enabled: 'false' } });

      expect(result).toEqual({ enabled: true, source: 'default' });
    });
  });

  describe('default', () => {
    it('defaults to enabled when no env vars or config', async () => {
      const result = await resolveTelemetryPreference({});

      expect(result).toEqual({ enabled: true, source: 'default' });
    });
  });
});

describe('validateEndpointUrl', () => {
  it('returns success with normalized URL for valid https endpoint', () => {
    const result = validateEndpointUrl('https://telemetry.example.com/v1/');
    expect(result).toEqual({ success: true, url: 'https://telemetry.example.com/v1' });
  });

  it('returns success for http endpoint', () => {
    const result = validateEndpointUrl('http://localhost:4318');
    expect(result).toEqual({ success: true, url: 'http://localhost:4318' });
  });

  it('strips trailing slashes', () => {
    const result = validateEndpointUrl('https://example.com/');
    expect(result).toEqual({ success: true, url: 'https://example.com' });
  });

  it('returns failure for non-http protocol', () => {
    const result = validateEndpointUrl('file:///etc/passwd');
    expect(result.success).toBe(false);
    expect(!result.success && result.error.message).toContain('Unsupported protocol');
  });

  it('returns failure for malformed URL', () => {
    const result = validateEndpointUrl('not-a-url');
    expect(result.success).toBe(false);
    expect(!result.success && result.error.message).toContain('Invalid URL');
  });
});

describe('resolveTelemetryEndpoint', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.AGENTCORE_TELEMETRY_ENDPOINT;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns endpoint from env var when valid', async () => {
    process.env.AGENTCORE_TELEMETRY_ENDPOINT = 'https://env.example.com';

    const result = await resolveTelemetryEndpoint({});

    expect(result).toBe('https://env.example.com');
  });

  it('falls back to config endpoint when env is unset', async () => {
    const result = await resolveTelemetryEndpoint({ telemetry: { endpoint: 'https://config.example.com' } });

    expect(result).toBe('https://config.example.com');
  });

  it('prefers env over config', async () => {
    process.env.AGENTCORE_TELEMETRY_ENDPOINT = 'https://env.example.com';

    const result = await resolveTelemetryEndpoint({ telemetry: { endpoint: 'https://config.example.com' } });

    expect(result).toBe('https://env.example.com');
  });

  it('falls back to the built-in default when nothing is configured', async () => {
    const result = await resolveTelemetryEndpoint({});

    expect(result).toBe(TELEMETRY_ENDPOINT);
  });

  it('falls back to the built-in default when env override is invalid', async () => {
    process.env.AGENTCORE_TELEMETRY_ENDPOINT = 'not-a-url';

    const result = await resolveTelemetryEndpoint({});

    expect(result).toBe(TELEMETRY_ENDPOINT);
  });

  it('falls back to the built-in default when config override is invalid', async () => {
    const result = await resolveTelemetryEndpoint({ telemetry: { endpoint: 'not-a-url' } });

    expect(result).toBe(TELEMETRY_ENDPOINT);
  });
});

describe('resolveAuditEnabled', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.AGENTCORE_TELEMETRY_AUDIT;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns true when env var is "1"', async () => {
    process.env.AGENTCORE_TELEMETRY_AUDIT = '1';

    expect(await resolveAuditEnabled({})).toBe(true);
  });

  it('returns true when config audit is true', async () => {
    expect(await resolveAuditEnabled({ telemetry: { audit: true } })).toBe(true);
  });

  it('returns false when neither env nor config enables audit', async () => {
    expect(await resolveAuditEnabled({})).toBe(false);
  });
});
