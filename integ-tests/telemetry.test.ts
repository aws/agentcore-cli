import { spawnAndCollect } from '../src/test-utils/cli-runner.js';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const testConfigDir = mkdtempSync(join(tmpdir(), 'agentcore-integ-'));
const cliPath = join(__dirname, '..', 'dist', 'cli', 'index.mjs');

function run(args: string[]) {
  return spawnAndCollect('node', [cliPath, ...args], tmpdir(), {
    AGENTCORE_SKIP_INSTALL: '1',
    AGENTCORE_CONFIG_DIR: testConfigDir,
  });
}

describe('telemetry e2e', () => {
  afterAll(() => rm(testConfigDir, { recursive: true, force: true }));

  it('disable → status shows Disabled, enable → status shows Enabled', async () => {
    await run(['telemetry', 'disable']);
    let status = await run(['telemetry', 'status']);
    expect(status.stdout).toContain('Disabled');
    expect(status.stdout).toContain('global config');

    await run(['telemetry', 'enable']);
    status = await run(['telemetry', 'status']);
    expect(status.stdout).toContain('Enabled');
    expect(status.stdout).toContain('global config');
  });
});
