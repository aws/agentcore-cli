import { exists, runCLI } from '../src/test-utils/index.js';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

function hasCommand(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const hasNpm = hasCommand('npm');
const hasGit = hasCommand('git');
const hasUv = hasCommand('uv');

describe('integration: create with Python agent', () => {
  let testDir: string;

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-integ-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it.skipIf(!hasNpm || !hasGit || !hasUv)('creates project with real uv venv and sync', async () => {
    const name = `IntegWithAgent${Date.now()}`;
    const result = await runCLI(
      [
        'create',
        '--name',
        name,
        '--language',
        'Python',
        '--framework',
        'Strands',
        '--model-provider',
        'Bedrock',
        '--memory',
        'none',
        '--json',
      ],
      testDir,
      false
    );

    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);

    const json = JSON.parse(result.stdout);
    expect(json.success).toBe(true);

    // Verify npm install ran
    expect(
      await exists(join(json.projectPath, 'agentcore', 'cdk', 'node_modules')),
      'node_modules/ should exist'
    ).toBeTruthy();

    // Verify git init ran
    expect(await exists(join(json.projectPath, '.git')), '.git/ should exist').toBeTruthy();

    // Verify uv venv ran - .venv in app/{agentName} directory
    const agentDir = join(json.projectPath, 'app', json.agentName || name);
    expect(await exists(join(agentDir, '.venv')), '.venv/ should exist in agent directory').toBeTruthy();
  });
});
