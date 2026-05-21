import { createTestProject, exists, readProjectConfig, runCLI } from '../src/test-utils/index.js';
import type { TestProject } from '../src/test-utils/index.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

async function readHarnessSpec(projectPath: string, harnessName: string) {
  return JSON.parse(await readFile(join(projectPath, `app/${harnessName}/harness.json`), 'utf-8'));
}

describe('integration: harness add/remove lifecycle', () => {
  let project: TestProject;
  const harnessName = 'TestHarness';

  beforeAll(async () => {
    project = await createTestProject({ noAgent: true });
  });

  afterAll(async () => {
    await project.cleanup();
  });

  it('adds a harness with defaults', async () => {
    const result = await runCLI(['add', 'harness', '--name', harnessName, '--json'], project.projectPath);

    expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.success).toBe(true);

    const config = await readProjectConfig(project.projectPath);
    const harness = config.harnesses?.find((h: { name: string }) => h.name === harnessName);
    expect(harness, `Harness "${harnessName}" should be in agentcore.json`).toBeTruthy();
    expect(harness!.path).toBe(`app/${harnessName}`);
  });

  it('creates harness.json with correct model config', async () => {
    const spec = await readHarnessSpec(project.projectPath, harnessName);
    expect(spec.model).toBeDefined();
    expect(spec.model.provider).toBe('bedrock');
    expect(spec.model.modelId).toBeTruthy();
  });

  it('creates system-prompt.md', async () => {
    const promptPath = join(project.projectPath, `app/${harnessName}/system-prompt.md`);
    expect(await exists(promptPath), 'system-prompt.md should exist').toBe(true);
  });

  it('auto-creates memory resource', async () => {
    const config = await readProjectConfig(project.projectPath);
    const memories = config.memories ?? [];
    expect(memories.length, 'Should have auto-created memory').toBeGreaterThan(0);
  });

  it('rejects duplicate harness name', async () => {
    const result = await runCLI(['add', 'harness', '--name', harnessName, '--json'], project.projectPath);
    expect(result.exitCode).not.toBe(0);
  });

  it('removes the harness', async () => {
    const result = await runCLI(['remove', 'harness', '--name', harnessName, '--json'], project.projectPath);

    expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.success).toBe(true);

    const config = await readProjectConfig(project.projectPath);
    const found = config.harnesses?.find((h: { name: string }) => h.name === harnessName);
    expect(found, `Harness "${harnessName}" should be removed`).toBeFalsy();
  });
});

describe('integration: harness configuration options', () => {
  let project: TestProject;

  beforeAll(async () => {
    project = await createTestProject({ noAgent: true });
  });

  afterAll(async () => {
    await project.cleanup();
  });

  it('adds harness with truncation strategy', async () => {
    const name = 'TruncHarness';
    const result = await runCLI(
      ['add', 'harness', '--name', name, '--truncation-strategy', 'sliding_window', '--json'],
      project.projectPath
    );

    expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);

    const spec = await readHarnessSpec(project.projectPath, name);
    expect(spec.truncation?.strategy).toBe('sliding_window');
  });

  it('adds harness with lifecycle config', async () => {
    const name = 'LifecycleHarness';
    const result = await runCLI(
      ['add', 'harness', '--name', name, '--idle-timeout', '300', '--max-lifetime', '3600', '--json'],
      project.projectPath
    );

    expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);

    const spec = await readHarnessSpec(project.projectPath, name);
    expect(spec.lifecycleConfig?.idleRuntimeSessionTimeout).toBe(300);
    expect(spec.lifecycleConfig?.maxLifetime).toBe(3600);
  });

  it('adds harness without memory when --no-memory is set', async () => {
    const name = 'NoMemHarness';
    const configBefore = await readProjectConfig(project.projectPath);
    const memoriesBefore = (configBefore.memories ?? []).length;

    const result = await runCLI(['add', 'harness', '--name', name, '--no-memory', '--json'], project.projectPath);

    expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);

    const configAfter = await readProjectConfig(project.projectPath);
    const memoriesAfter = (configAfter.memories ?? []).length;
    expect(memoriesAfter).toBe(memoriesBefore);
  });

  it('adds harness with non-bedrock model provider', async () => {
    const name = 'OpenAIHarness';
    const result = await runCLI(
      [
        'add',
        'harness',
        '--name',
        name,
        '--model-provider',
        'open_ai',
        '--model-id',
        'gpt-5',
        '--api-key-arn',
        'arn:aws:secretsmanager:us-east-1:123456789012:secret:openai-key',
        '--json',
      ],
      project.projectPath
    );

    expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);

    const spec = await readHarnessSpec(project.projectPath, name);
    expect(spec.model.provider).toBe('open_ai');
    expect(spec.model.modelId).toBe('gpt-5');
    expect(spec.model.apiKeyArn).toBe('arn:aws:secretsmanager:us-east-1:123456789012:secret:openai-key');
  });
});

describe('integration: harness validation errors', () => {
  let project: TestProject;

  beforeAll(async () => {
    project = await createTestProject({ noAgent: true });
  });

  afterAll(async () => {
    await project.cleanup();
  });

  it('rejects invalid harness name with special characters', async () => {
    const result = await runCLI(['add', 'harness', '--name', 'bad-name!', '--json'], project.projectPath);
    expect(result.exitCode).not.toBe(0);
  });

  it('rejects harness name starting with a number', async () => {
    const result = await runCLI(['add', 'harness', '--name', '1BadName', '--json'], project.projectPath);
    expect(result.exitCode).not.toBe(0);
  });

  it('rejects add harness without --name when --json is passed', async () => {
    const result = await runCLI(['add', 'harness', '--json'], project.projectPath);
    expect(result.exitCode).not.toBe(0);
  });
});

describe('integration: create project with harness', () => {
  let project: TestProject;
  const harnessName = 'CreateHarness';

  beforeAll(async () => {
    project = await createTestProject({ name: harnessName, noAgent: true });
    await runCLI(['add', 'harness', '--name', harnessName, '--json'], project.projectPath);
  });

  afterAll(async () => {
    await project.cleanup();
  });

  it('has correct project scaffolding', async () => {
    expect(await exists(join(project.projectPath, 'agentcore/agentcore.json'))).toBe(true);
    expect(await exists(join(project.projectPath, 'agentcore/cdk'))).toBe(true);
    expect(await exists(join(project.projectPath, `app/${harnessName}/harness.json`))).toBe(true);
    expect(await exists(join(project.projectPath, `app/${harnessName}/system-prompt.md`))).toBe(true);
  });

  it('has harness registered in project config', async () => {
    const config = await readProjectConfig(project.projectPath);
    const harness = config.harnesses?.find((h: { name: string }) => h.name === harnessName);
    expect(harness).toBeTruthy();
  });
});
