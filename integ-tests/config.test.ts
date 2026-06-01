import { spawnAndCollect } from '../src/test-utils/cli-runner.js';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const testConfigDir = mkdtempSync(join(tmpdir(), 'agentcore-config-integ-'));
const cliPath = join(__dirname, '..', 'dist', 'cli', 'index.mjs');

function run(args: string[]) {
  return spawnAndCollect('node', [cliPath, ...args], tmpdir(), {
    AGENTCORE_SKIP_INSTALL: '1',
    AGENTCORE_CONFIG_DIR: testConfigDir,
  });
}

function readConfig() {
  return JSON.parse(readFileSync(join(testConfigDir, 'config.json'), 'utf-8'));
}

describe('config command', () => {
  afterAll(() => rm(testConfigDir, { recursive: true, force: true }));

  it('lists config with installationId when fresh', async () => {
    const result = await run(['config']);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.installationId).toBeDefined();
  });

  it('sets a string value', async () => {
    const result = await run(['config', 'uvIndex', 'https://example.com']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Set uvIndex = https://example.com');
    expect(readConfig().uvIndex).toBe('https://example.com');
  });

  it('gets a value', async () => {
    const result = await run(['config', 'uvIndex']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('"https://example.com"');
  });

  it('sets a nested value with dot notation', async () => {
    const result = await run(['config', 'telemetry.endpoint', 'https://metrics.example.com']);
    expect(result.exitCode).toBe(0);
    expect(readConfig().telemetry.endpoint).toBe('https://metrics.example.com');
  });

  it('gets a nested value with dot notation', async () => {
    const result = await run(['config', 'telemetry.endpoint']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('"https://metrics.example.com"');
  });

  it('gets an object value as JSON', async () => {
    const result = await run(['config', 'telemetry']);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.endpoint).toBe('https://metrics.example.com');
  });

  it('sets a boolean value via JSON parsing', async () => {
    const result = await run(['config', 'telemetry.enabled', 'true']);
    expect(result.exitCode).toBe(0);
    expect(readConfig().telemetry.enabled).toBe(true);
  });

  it('sets a numeric value via JSON parsing', async () => {
    const result = await run(['config', 'transactionSearchIndexPercentage', '50']);
    expect(result.exitCode).toBe(0);
    expect(readConfig().transactionSearchIndexPercentage).toBe(50);
  });

  it('rejects invalid value for a typed key', async () => {
    const result = await run(['config', 'telemetry.enabled', 'notabool']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Invalid value');
  });

  it('rejects unknown keys', async () => {
    const result = await run(['config', 'foo.bar.baz', 'hello']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Invalid value');
  });

  it('returns error for unset key', async () => {
    const result = await run(['config', 'disableTransactionSearch']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('is not set');
  });

  it('lists all config after mutations', async () => {
    const result = await run(['config']);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.uvIndex).toBe('https://example.com');
    expect(parsed.telemetry.endpoint).toBe('https://metrics.example.com');
  });

  describe('corrupt config file', () => {
    const corruptDir = mkdtempSync(join(tmpdir(), 'agentcore-config-corrupt-'));
    const corruptFile = join(corruptDir, 'config.json');

    afterAll(() => rm(corruptDir, { recursive: true, force: true }));

    function runCorrupt(args: string[]) {
      return spawnAndCollect('node', [cliPath, ...args], tmpdir(), {
        AGENTCORE_SKIP_INSTALL: '1',
        AGENTCORE_CONFIG_DIR: corruptDir,
      });
    }

    it('exits non-zero with a clear error when listing a corrupt config', async () => {
      writeFileSync(corruptFile, '{ this is not valid json');

      const result = await runCorrupt(['config']);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(`Error: Unable to parse config file at ${corruptFile}`);
    });

    it('exits non-zero with a clear error when getting a key from a non-object config', async () => {
      writeFileSync(corruptFile, '"a string"');

      const result = await runCorrupt(['config', 'telemetry.enabled']);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(`Error: Unable to parse config file at ${corruptFile}`);
    });
  });

  describe('installationId validation', () => {
    it('rejects setting installationId to a non-UUID value', async () => {
      const result = await run(['config', 'installationId', 'my-custom-id']);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Invalid value');
    });
  });
});
