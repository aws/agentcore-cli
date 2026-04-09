import {
  getOrCreateInstallationId,
  readGlobalConfig,
  readGlobalConfigSync,
  updateGlobalConfig,
} from '../../lib/schemas/io/global-config';
import { createTempConfig } from './helpers/temp-config';
import { readFile, writeFile } from 'fs/promises';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const tmp = createTempConfig('gc');

describe('global-config', () => {
  beforeEach(() => tmp.setup());
  afterAll(() => tmp.cleanup());

  describe('readGlobalConfig', () => {
    it('returns parsed config when file exists', async () => {
      await writeFile(tmp.configFile, JSON.stringify({ telemetry: { enabled: false } }));

      const config = await readGlobalConfig(tmp.configFile);

      expect(config).toEqual({ telemetry: { enabled: false } });
    });

    it('returns empty object when file is missing or invalid', async () => {
      expect(await readGlobalConfig(tmp.testDir + '/nonexistent.json')).toEqual({});

      await writeFile(tmp.configFile, 'not json');
      expect(await readGlobalConfig(tmp.configFile)).toEqual({});
    });

    it('drops invalid fields while preserving valid ones', async () => {
      await writeFile(
        tmp.configFile,
        JSON.stringify({
          transactionSearchIndexPercentage: 'not-a-number',
          uvIndex: 'https://valid.url',
          telemetry: { enabled: 'yes', endpoint: 'https://example.com' },
        })
      );

      const config = await readGlobalConfig(tmp.configFile);

      expect(config).toEqual({
        transactionSearchIndexPercentage: undefined,
        uvIndex: 'https://valid.url',
        telemetry: { enabled: undefined, endpoint: 'https://example.com' },
      });
    });

    it('preserves unknown fields via passthrough', async () => {
      const full = {
        installationId: 'abc-123',
        telemetry: { enabled: true, endpoint: 'https://example.com', audit: false },
        futureField: 'hello',
      };
      await writeFile(tmp.configFile, JSON.stringify(full));

      const config = await readGlobalConfig(tmp.configFile);

      expect(config).toEqual(full);
    });
  });

  describe('readGlobalConfigSync', () => {
    it('returns parsed config when file exists', async () => {
      await writeFile(tmp.configFile, JSON.stringify({ telemetry: { enabled: false } }));

      expect(readGlobalConfigSync(tmp.configFile)).toEqual({ telemetry: { enabled: false } });
    });

    it('returns empty object when file is missing or invalid', async () => {
      expect(readGlobalConfigSync(tmp.testDir + '/nonexistent.json')).toEqual({});

      await writeFile(tmp.configFile, 'not json');
      expect(readGlobalConfigSync(tmp.configFile)).toEqual({});
    });
  });

  describe('updateGlobalConfig', () => {
    it('creates directory and writes config when none exists', async () => {
      const fresh = createTempConfig('gc-fresh');

      const ok = await updateGlobalConfig({ telemetry: { enabled: false } }, fresh.configDir, fresh.configFile);

      expect(ok).toBe(true);
      const written = JSON.parse(await readFile(fresh.configFile, 'utf-8'));
      expect(written).toEqual({ telemetry: { enabled: false } });

      await fresh.cleanup();
    });

    it('deep-merges telemetry sub-object with existing config', async () => {
      await writeFile(
        tmp.configFile,
        JSON.stringify({ installationId: 'keep-me', telemetry: { enabled: true, endpoint: 'https://x.com' } })
      );

      await updateGlobalConfig({ telemetry: { enabled: false } }, tmp.configDir, tmp.configFile);

      const written = JSON.parse(await readFile(tmp.configFile, 'utf-8'));
      expect(written).toEqual({
        installationId: 'keep-me',
        telemetry: { enabled: false, endpoint: 'https://x.com' },
      });
    });

    it('returns false on write failures', async () => {
      const ok = await updateGlobalConfig(
        { telemetry: { enabled: true } },
        tmp.testDir + '/\0invalid',
        tmp.testDir + '/\0invalid/config.json'
      );

      expect(ok).toBe(false);
    });
  });

  describe('getOrCreateInstallationId', () => {
    it('generates installationId on first run and returns created: true', async () => {
      const result = await getOrCreateInstallationId(tmp.configDir, tmp.configFile);

      expect(result.created).toBe(true);
      expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
      const config = await readGlobalConfig(tmp.configFile);
      expect(config.installationId).toBe(result.id);
    });

    it('returns existing id with created: false', async () => {
      await writeFile(tmp.configFile, JSON.stringify({ installationId: 'existing-id' }));

      const result = await getOrCreateInstallationId(tmp.configDir, tmp.configFile);

      expect(result).toEqual({ id: 'existing-id', created: false });
    });
  });
});
