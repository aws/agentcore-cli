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

function hasAwsCredentials(): boolean {
  try {
    execSync('aws sts get-caller-identity', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const hasNpm = hasCommand('npm');
const hasGit = hasCommand('git');
const hasUv = hasCommand('uv');
const hasAws = hasAwsCredentials();

describe('integration: deploy', () => {
  let testDir: string;
  let projectPath: string;
  const targetName = `integ-${Date.now()}`;

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-integ-deploy-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    // Create a project with agent
    const name = `Deploy${Date.now()}`;
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

      // Add a deployment target
      await runCLI(
        [
          'add',
          'target',
          '--name',
          targetName,
          '--account',
          process.env.AWS_ACCOUNT_ID || '603141041947',
          '--region',
          process.env.AWS_REGION || 'us-east-1',
          '--json',
        ],
        projectPath,
        false
      );
    }
  }, 120000);

  afterAll(async () => {
    // Destroy resources and verify it succeeds
    if (projectPath && hasAws) {
      const result = await runCLI(['destroy', '--target', targetName, '--yes', '--json'], projectPath, false);

      // Assert destroy succeeded
      expect(result.exitCode, `Destroy failed: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success, 'Destroy should report success').toBe(true);
    }
    await rm(testDir, { recursive: true, force: true });
  }, 120000);

  it.skipIf(!hasNpm || !hasGit || !hasUv || !hasAws)(
    'deploys to AWS successfully',
    async () => {
      expect(projectPath, 'Project should have been created').toBeTruthy();

      const result = await runCLI(['deploy', '--target', targetName, '--yes', '--json'], projectPath, false);

      if (result.exitCode !== 0) {
        console.log('Deploy stdout:', result.stdout);
        console.log('Deploy stderr:', result.stderr);
      }

      expect(result.exitCode, `Deploy failed: ${result.stderr}`).toBe(0);

      const json = JSON.parse(result.stdout);
      expect(json.success, 'Deploy should report success').toBe(true);
    },
    180000
  );
});
