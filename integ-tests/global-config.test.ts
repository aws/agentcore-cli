import { runCLI } from '../src/test-utils/index.js';
import { chmod, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

interface TempConfig {
  configDir: string;
  configFile: string;
  /** Read and parse config.json. Returns {} if the file does not exist. */
  read: () => Promise<Record<string, unknown>>;
  /** Run the CLI with this temp dir as AGENTCORE_CONFIG_DIR. */
  runCLI: (args: string[]) => ReturnType<typeof runCLI>;
}

async function makeTempConfig(): Promise<TempConfig> {
  const configDir = join(tmpdir(), `agentcore-tel-endpoint-${randomUUID()}`);
  const configFile = join(configDir, 'config.json');
  await mkdir(configDir, { recursive: true });
  return {
    configDir,
    configFile,
    read: async () => {
      try {
        return JSON.parse(await readFile(configFile, 'utf-8')) as Record<string, unknown>;
      } catch {
        return {};
      }
    },
    runCLI: args => runCLI(args, process.cwd(), { env: { AGENTCORE_CONFIG_DIR: configDir } }),
  };
}

describe('integration: global config', () => {
  let tmp: TempConfig;

  beforeEach(async () => {
    tmp = await makeTempConfig();
  });

  afterEach(async () => {
    // Restore writable permissions on the file before cleanup so rm can unlink it
    // when a test left it read-only.
    await chmod(tmp.configFile, 0o644).catch(() => undefined);
    await rm(tmp.configDir, { recursive: true, force: true });
  });

});
