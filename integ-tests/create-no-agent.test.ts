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

describe('integration: create without agent', () => {
  let testDir: string;

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-integ-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it.skipIf(!hasNpm || !hasGit)('creates project with real npm install and git init', async () => {
    const name = `IntegNoAgent${Date.now()}`;
    const result = await runCLI(['create', '--name', name, '--no-agent', '--json'], testDir, false);

    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);

    const json = JSON.parse(result.stdout);
    expect(json.success).toBe(true);

    // Verify npm install ran (in CDK project directory)
    expect(
      await exists(join(json.projectPath, 'agentcore', 'cdk', 'node_modules')),
      'agentcore/cdk/node_modules/ should exist'
    ).toBeTruthy();

    // Verify git init ran
    expect(await exists(join(json.projectPath, '.git')), '.git/ should exist').toBeTruthy();

    // Verify at least one commit
    const gitLog = execSync('git log --oneline', { cwd: json.projectPath, encoding: 'utf-8' });
    expect(gitLog.trim().length > 0, 'Should have at least one commit').toBeTruthy();
  });
});
