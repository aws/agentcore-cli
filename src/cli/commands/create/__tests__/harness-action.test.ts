import { exists } from '../../../../test-utils/index.js';
import { createProjectWithHarness } from '../harness-action.js';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('createProjectWithHarness', () => {
  let testDir: string;

  beforeAll(() => {
    testDir = join(tmpdir(), `harness-action-${randomUUID()}`);
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('creates project with harness', async () => {
    const name = `TestH${randomUUID().slice(0, 6)}`;
    const result = await createProjectWithHarness({
      name,
      cwd: testDir,
      modelProvider: 'bedrock',
      modelId: 'global.anthropic.claude-sonnet-4-6',
      skipGit: true,
      skipInstall: true,
    });

    expect(result.success, `Error: ${result.error}`).toBe(true);
    expect(result.projectPath).toBeTruthy();

    const projectPath = result.projectPath!;
    const configDir = join(projectPath, 'agentcore');
    const harnessDir = join(projectPath, 'app', name);

    await expect(exists(projectPath)).resolves.toBe(true);
    await expect(exists(configDir)).resolves.toBe(true);
    await expect(exists(harnessDir)).resolves.toBe(true);
    await expect(exists(join(harnessDir, 'harness.json'))).resolves.toBe(true);
    await expect(exists(join(harnessDir, 'system-prompt.md'))).resolves.toBe(true);
  });

  it('uses projectName for project scaffold and name for harness resource', async () => {
    const projectName = `Proj${randomUUID().slice(0, 6)}`;
    const name = `HarnessName${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const result = await createProjectWithHarness({
      name,
      projectName,
      cwd: testDir,
      modelProvider: 'bedrock',
      modelId: 'global.anthropic.claude-sonnet-4-6',
      skipGit: true,
      skipInstall: true,
    });

    expect(result.success, `Error: ${result.error}`).toBe(true);
    expect(result.projectPath).toBe(join(testDir, projectName));

    await expect(exists(join(result.projectPath!, 'agentcore'))).resolves.toBe(true);
    await expect(exists(join(result.projectPath!, 'app', name, 'harness.json'))).resolves.toBe(true);
  });

  it('creates harness with custom options', async () => {
    const name = `CustomH${randomUUID().slice(0, 6)}`;
    const result = await createProjectWithHarness({
      name,
      cwd: testDir,
      modelProvider: 'open_ai',
      modelId: 'gpt-4',
      apiKeyArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:my-key',
      skipMemory: true,
      maxIterations: 10,
      maxTokens: 2000,
      timeoutSeconds: 300,
      truncationStrategy: 'sliding_window',
      networkMode: 'PUBLIC',
      skipGit: true,
      skipInstall: true,
    });

    expect(result.success, `Error: ${result.error}`).toBe(true);
    expect(result.projectPath).toBeTruthy();

    const harnessJsonPath = join(result.projectPath!, 'app', name, 'harness.json');
    await expect(exists(harnessJsonPath)).resolves.toBe(true);
  });

  it('reports progress during creation', async () => {
    const name = `ProgH${randomUUID().slice(0, 6)}`;
    const progressSteps: string[] = [];

    const result = await createProjectWithHarness({
      name,
      cwd: testDir,
      modelProvider: 'bedrock',
      modelId: 'global.anthropic.claude-sonnet-4-6',
      skipGit: true,
      skipInstall: true,
      onProgress: (step, status) => {
        if (status === 'done') {
          progressSteps.push(step);
        }
      },
    });

    expect(result.success, `Error: ${result.error}`).toBe(true);
    expect(progressSteps).toContain('Add harness to project');
  });

  it('handles errors gracefully', async () => {
    const name = '!!!invalid-name!!!';
    const result = await createProjectWithHarness({
      name,
      cwd: testDir,
      modelProvider: 'bedrock',
      modelId: 'global.anthropic.claude-sonnet-4-6',
      skipGit: true,
      skipInstall: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
