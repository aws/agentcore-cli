import { readGlobalConfig } from '../../../../lib/schemas/io/global-config';
import { createTempConfig } from '../../../__tests__/helpers/temp-config';
import { handleTelemetryDisable, handleTelemetryEnable, handleTelemetryStatus } from '../actions';
import { chmod, mkdir, rm, writeFile } from 'fs/promises';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = createTempConfig('actions');

describe('telemetry actions', () => {
  const originalEnv = process.env;

  beforeEach(() => tmp.setup());

  afterEach(() => {
    process.env = originalEnv;
  });

  afterAll(() => tmp.cleanup());

  describe('handleTelemetryDisable', () => {
    it('writes disabled to config and returns true', async () => {
      const ok = await handleTelemetryDisable(tmp.configDir, tmp.configFile);

      expect(ok).toBe(true);
      const config = await readGlobalConfig(tmp.configFile);
      expect(config.telemetry?.enabled).toBe(false);
    });

    it('returns false when config write fails', async () => {
      await rm(tmp.testDir, { recursive: true, force: true });
      await mkdir(tmp.testDir, { recursive: true });
      await chmod(tmp.testDir, 0o444);

      const ok = await handleTelemetryDisable(tmp.configDir, tmp.configFile);

      expect(ok).toBe(false);

      await chmod(tmp.testDir, 0o755);
    });
  });

  describe('handleTelemetryEnable', () => {
    it('writes enabled to config and returns true', async () => {
      const ok = await handleTelemetryEnable(tmp.configDir, tmp.configFile);

      expect(ok).toBe(true);
      const config = await readGlobalConfig(tmp.configFile);
      expect(config.telemetry?.enabled).toBe(true);
    });
  });

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
