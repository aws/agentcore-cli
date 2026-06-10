import {
  getOrCreateInstallationId,
  readGlobalConfig,
  readGlobalConfigSync,
  updateGlobalConfig,
} from '../../lib/schemas/io/global-config';
import { createTempConfig } from './helpers/temp-config';
import { readFile, writeFile } from 'fs/promises';
import assert from 'node:assert';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const tmp = createTempConfig('gc');

describe('global-config', () => {
  beforeEach(() => tmp.setup());
  afterAll(() => tmp.cleanup());

  describe('readGlobalConfig', () => {
    it('returns success with parsed config when file exists', async () => {
      await writeFile(tmp.configFile, JSON.stringify({ telemetry: { enabled: false } }));

      const result = await readGlobalConfig(tmp.configFile);

      expect(result).toEqual({ success: true, config: { telemetry: { enabled: false } } });
    });

    it('returns success with empty config when file is missing', async () => {
      const result = await readGlobalConfig(tmp.testDir + '/nonexistent.json');

      expect(result).toEqual({ success: true, config: {} });
    });

    it('returns failure when file is malformed JSON', async () => {
      await writeFile(tmp.configFile, 'not json');

      const result = await readGlobalConfig(tmp.configFile);

      assert(!result.success);
      expect(result.error).toBeInstanceOf(Error);
    });

    it('returns failure when JSON is valid but not an object', async () => {
      await writeFile(tmp.configFile, '"a string"');

      const result = await readGlobalConfig(tmp.configFile);

      assert(!result.success);
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

      const result = await readGlobalConfig(tmp.configFile);

      assert(result.success);
      expect(result.config).toEqual({
        transactionSearchIndexPercentage: undefined,
        uvIndex: 'https://valid.url',
        telemetry: { enabled: undefined, endpoint: 'https://example.com' },
      });
    });

    it('preserves unknown fields via passthrough', async () => {
      const full = {
        installationId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
        telemetry: { enabled: true, endpoint: 'https://example.com', audit: false },
        futureField: 'hello',
      };
      await writeFile(tmp.configFile, JSON.stringify(full));

      const result = await readGlobalConfig(tmp.configFile);

      assert(result.success);
      expect(result.config).toEqual(full);
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
      const validUuid = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
      await writeFile(
        tmp.configFile,
        JSON.stringify({ installationId: validUuid, telemetry: { enabled: true, endpoint: 'https://x.com' } })
      );

      await updateGlobalConfig({ telemetry: { enabled: false } }, tmp.configDir, tmp.configFile);

      const written = JSON.parse(await readFile(tmp.configFile, 'utf-8'));
      expect(written).toEqual({
        installationId: validUuid,
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

    it('does not overwrite when existing file is malformed JSON', async () => {
      const corrupt = '{ this is not valid json';
      await writeFile(tmp.configFile, corrupt);

      const ok = await updateGlobalConfig({ telemetry: { enabled: false } }, tmp.configDir, tmp.configFile);

      expect(ok).toBe(false);
      const onDisk = await readFile(tmp.configFile, 'utf-8');
      expect(onDisk).toBe(corrupt);
    });
  });

  describe('getOrCreateInstallationId', () => {
    it('generates installationId on first run and returns created: true', async () => {
      const result = await getOrCreateInstallationId(tmp.configDir, tmp.configFile);

      assert(result.success);
      expect(result.created).toBe(true);
      expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
      const read = await readGlobalConfig(tmp.configFile);
      assert(read.success);
      expect(read.config.installationId).toBe(result.id);
    });

    it('returns existing id with created: false', async () => {
      const validUuid = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
      await writeFile(tmp.configFile, JSON.stringify({ installationId: validUuid }));

      const result = await getOrCreateInstallationId(tmp.configDir, tmp.configFile);

      expect(result).toEqual({ success: true, id: validUuid, created: false });
    });

    it('regenerates id when existing value is not a valid UUID', async () => {
      await writeFile(tmp.configFile, JSON.stringify({ installationId: 'my-custom-id' }));

      const result = await getOrCreateInstallationId(tmp.configDir, tmp.configFile);

      assert(result.success);
      expect(result.created).toBe(true);
      expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.id).not.toBe('my-custom-id');
      const read = await readGlobalConfig(tmp.configFile);
      assert(read.success);
      expect(read.config.installationId).toBe(result.id);
    });

    it('regenerates id when existing value is an empty string', async () => {
      await writeFile(tmp.configFile, JSON.stringify({ installationId: '' }));

      const result = await getOrCreateInstallationId(tmp.configDir, tmp.configFile);

      assert(result.success);
      expect(result.created).toBe(true);
      expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('returns failure when existing config is unreadable', async () => {
      await writeFile(tmp.configFile, '{ malformed json');

      const result = await getOrCreateInstallationId(tmp.configDir, tmp.configFile);

      assert(!result.success);
      expect(result.error).toBeInstanceOf(Error);
    });

    it('returns failure when the new id cannot be persisted', async () => {
      const result = await getOrCreateInstallationId(
        tmp.testDir + '/\0invalid',
        tmp.testDir + '/\0invalid/config.json'
      );

      assert(!result.success);
      expect(result.error).toBeInstanceOf(Error);
    });
  });
});
