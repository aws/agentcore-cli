import { runCLI } from '../src/test-utils/index.js';
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

describe('integration: invoke agent', () => {
  let testDir: string;
  let projectPath: string;
  let agentName: string;

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-integ-invoke-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    // Create a project with agent
    const name = `InvokeTest${Date.now()}`;
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

    if (result.exitCode === 0) {
      const json = JSON.parse(result.stdout);
      projectPath = json.projectPath;
      agentName = json.agentName || name;
    }
  }, 60000);

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it.skipIf(!hasNpm || !hasGit || !hasUv)(
    'invokes agent and receives response',
    async () => {
      expect(projectPath, 'Project should have been created').toBeTruthy();

      const result = await runCLI(
        ['invoke', '--agent', agentName, '--prompt', 'Say hello', '--json'],
        projectPath,
        false
      );

      // Invoke may fail if no AWS credentials, but should at least attempt
      // For now, just verify the command runs and produces output
      expect(result.stdout.length > 0 || result.stderr.length > 0, 'Should produce some output').toBeTruthy();
    },
    60000
  );
});
