import { runCLI } from '../../../../test-utils/index.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('add target command', () => {
  let testDir: string;
  let projectDir: string;

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-add-target-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    // Create a project first
    const projectName = 'TestProj';
    const result = await runCLI(['create', '--name', projectName, '--no-agent'], testDir);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create project: ${result.stdout} ${result.stderr}`);
    }
    projectDir = join(testDir, projectName);
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('adds target with valid inputs', async () => {
    const result = await runCLI(
      ['add', 'target', '--name', 'dev', '--account', '123456789012', '--region', 'us-east-1', '--json'],
      projectDir
    );

    expect(result.exitCode, `stdout: ${result.stdout}`).toBe(0);

    const json = JSON.parse(result.stdout);
    expect(json.success).toBe(true);

    // Verify target in file
    const targets = JSON.parse(await readFile(join(projectDir, 'agentcore/aws-targets.json'), 'utf-8'));
    expect(targets.length).toBe(1);
    expect(targets[0].name).toBe('dev');
  });

  it('rejects duplicate target name', async () => {
    const result = await runCLI(
      ['add', 'target', '--name', 'dev', '--account', '123456789012', '--region', 'us-west-2', '--json'],
      projectDir
    );

    expect(result.exitCode).toBe(1);

    const json = JSON.parse(result.stdout);
    expect(json.success).toBe(false);
    expect(json.error.includes('already exists')).toBeTruthy();
  });

  it('rejects invalid account ID', async () => {
    const result = await runCLI(
      ['add', 'target', '--name', 'prod', '--account', 'invalid', '--region', 'us-east-1', '--json'],
      projectDir
    );

    expect(result.exitCode).toBe(1);

    const json = JSON.parse(result.stdout);
    expect(json.success).toBe(false);
    expect(json.error.includes('12 digits')).toBeTruthy();
  });

  it('rejects invalid region name', async () => {
    const result = await runCLI(
      [
        'add',
        'target',
        '--name',
        'invalid-region-target',
        '--account',
        '123456789012',
        '--region',
        'invalid-region-123',
        '--json',
      ],
      projectDir
    );

    expect(result.exitCode).toBe(1);

    const json = JSON.parse(result.stdout);
    expect(json.success).toBe(false);
    expect(json.error.toLowerCase().includes('region'), `Expected region error, got: ${json.error}`).toBeTruthy();
  });

  it('requires all flags', async () => {
    const result = await runCLI(['add', 'target', '--name', 'staging', '--json'], projectDir);

    expect(result.exitCode).toBe(1);

    const json = JSON.parse(result.stdout);
    expect(json.success).toBe(false);
    expect(json.error.includes('Required')).toBeTruthy();
  });
});
