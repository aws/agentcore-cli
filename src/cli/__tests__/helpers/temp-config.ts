import { mkdir, rm } from 'fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TempConfigPaths {
  testDir: string;
  configDir: string;
  configFile: string;
  setup: () => Promise<void>;
  cleanup: () => Promise<void>;
}

export function createTempConfig(label: string): TempConfigPaths {
  const testDir = join(tmpdir(), `agentcore-${label}-${randomUUID()}`);
  const configDir = join(testDir, '.agentcore');
  const configFile = join(configDir, 'config.json');
  return {
    testDir,
    configDir,
    configFile,
    setup: async () => {
      await rm(testDir, { recursive: true, force: true });
      await mkdir(configDir, { recursive: true });
    },
    cleanup: () => rm(testDir, { recursive: true, force: true }),
  };
}
