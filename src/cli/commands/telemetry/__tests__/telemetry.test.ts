import { createTempConfig } from '../../../__tests__/helpers/temp-config';
import { handleTelemetryStatus } from '../actions';
import { writeFile } from 'fs/promises';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = createTempConfig('actions');

describe('telemetry actions', () => {
  const originalEnv = process.env;

  beforeEach(async () => {
    await tmp.setup();
    delete process.env.AGENTCORE_TELEMETRY_DISABLED;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  afterAll(() => tmp.cleanup());

  describe('handleTelemetryStatus', () => {
    it('reports default source when no config exists', async () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

      await handleTelemetryStatus(tmp.configFile);

      const output = spy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('Enabled');
      expect(output).toContain('default');
      spy.mockRestore();
    });

    it('reports global-config source when config exists', async () => {
      await writeFile(tmp.configFile, JSON.stringify({ telemetry: { enabled: false } }));
      const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

      await handleTelemetryStatus(tmp.configFile);

      const output = spy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('Disabled');
      expect(output).toContain('global config');
      spy.mockRestore();
    });

    it('reports environment source with env var note', async () => {
      process.env = { ...originalEnv, AGENTCORE_TELEMETRY_DISABLED: 'true' };
      const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

      await handleTelemetryStatus(tmp.configFile);

      const output = spy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('Disabled');
      expect(output).toContain('environment');
      expect(output).toContain('AGENTCORE_TELEMETRY_DISABLED');
      spy.mockRestore();
    });
  });
});
