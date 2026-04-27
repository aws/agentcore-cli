import { createTempConfig } from '../../__tests__/helpers/temp-config';
import { resolveTelemetryPreference } from '../config';
import { writeFile } from 'fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

const tmp = createTempConfig('resolve');

describe('resolveTelemetryPreference', () => {
  const originalEnv = process.env;

  beforeEach(async () => {
    process.env = { ...originalEnv };
    delete process.env.AGENTCORE_TELEMETRY_DISABLED;
    await tmp.setup();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  afterAll(() => tmp.cleanup());

  describe('AGENTCORE_TELEMETRY_DISABLED env var', () => {
    it('disables telemetry for any non-false/non-0 value', async () => {
      for (const val of ['true', 'TRUE', '1', 'yes']) {
        process.env.AGENTCORE_TELEMETRY_DISABLED = val;

        const result = await resolveTelemetryPreference(tmp.configFile);

        expect(result).toMatchObject({ enabled: false, source: 'environment' });
        expect(result.envVar).toEqual({ name: 'AGENTCORE_TELEMETRY_DISABLED', value: val });
      }
    });

    it('enables telemetry when set to "false" or "0"', async () => {
      for (const val of ['false', '0']) {
        process.env.AGENTCORE_TELEMETRY_DISABLED = val;

        const result = await resolveTelemetryPreference(tmp.configFile);

        expect(result).toMatchObject({ enabled: true, source: 'environment' });
        expect(result.envVar).toEqual({ name: 'AGENTCORE_TELEMETRY_DISABLED', value: val });
      }
    });
  });

  describe('global config', () => {
    it('uses config file when no env vars set', async () => {
      await writeFile(tmp.configFile, JSON.stringify({ telemetry: { enabled: false } }));

      const result = await resolveTelemetryPreference(tmp.configFile);

      expect(result).toEqual({ enabled: false, source: 'global-config' });
    });

    it('ignores non-boolean enabled values in config', async () => {
      await writeFile(tmp.configFile, JSON.stringify({ telemetry: { enabled: 'false' } }));

      const result = await resolveTelemetryPreference(tmp.configFile);

      expect(result).toEqual({ enabled: true, source: 'default' });
    });
  });

  describe('default', () => {
    it('defaults to enabled when no env vars or config', async () => {
      const result = await resolveTelemetryPreference(join(tmp.testDir, 'nonexistent.json'));

      expect(result).toEqual({ enabled: true, source: 'default' });
    });
  });
});
