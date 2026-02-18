import { runCLI } from '../../../../test-utils/index.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('remove all command', () => {
  let testDir: string;
  let projectDir: string;

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-remove-all-${randomUUID()}`);

    await mkdir(testDir, { recursive: true });

    // Create project with agent
    const projectName = 'RemoveAllTestProj';
    let result = await runCLI(['create', '--name', projectName, '--no-agent'], testDir);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create project: ${result.stdout} ${result.stderr}`);
    }
    projectDir = join(testDir, projectName);

    // Add an agent
    result = await runCLI(
      [
        'add',
        'agent',
        '--name',
        'TestAgent',
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
      projectDir
    );
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create agent: ${result.stdout} ${result.stderr}`);
    }
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('preserves aws-targets.json and deployed-state.json after remove all', async () => {
    // Write aws-targets.json so we can verify it's preserved
    const awsTargetsPath = join(projectDir, 'agentcore', 'aws-targets.json');

    await writeFile(
      awsTargetsPath,
      JSON.stringify([{ name: 'default', account: '123456789012', region: 'us-east-1' }])
    );

    // Simulate a deployed state entry so we can verify it is preserved
    // deployed-state.json lives in agentcore/.cli/
    const cliDir = join(projectDir, 'agentcore', '.cli');

    await mkdir(cliDir, { recursive: true });
    const deployedStatePath = join(cliDir, 'deployed-state.json');

    await writeFile(
      deployedStatePath,
      JSON.stringify({ targets: { default: { resources: { stackName: 'TestStack' } } } })
    );

    // Run remove all
    const result = await runCLI(['remove', 'all', '--force', '--json'], projectDir);
    expect(result.exitCode).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.success).toBe(true);

    // Verify aws-targets.json is preserved (NOT reset to empty)

    const targetsAfter = JSON.parse(await readFile(awsTargetsPath, 'utf-8'));
    expect(targetsAfter.length, 'aws-targets.json should be preserved after remove all').toBe(1);

    // Verify deployed-state.json is preserved (NOT reset to empty)

    const deployedStateAfter = JSON.parse(await readFile(deployedStatePath, 'utf-8'));
    expect(
      Object.keys(deployedStateAfter.targets).length,
      'deployed-state.json targets should be preserved after remove all'
    ).toBe(1);

    // Verify agentcore.json agents ARE cleared

    const schema = JSON.parse(await readFile(join(projectDir, 'agentcore', 'agentcore.json'), 'utf-8'));
    expect(schema.agents.length, 'Agents should be cleared after remove all').toBe(0);
  });

  it('includes note about source code in remove all result', async () => {
    const result = await runCLI(['remove', 'all', '--force', '--json'], projectDir);
    expect(result.exitCode).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.success).toBe(true);
    expect(json.note, 'Should include source code note').toBeDefined();
    expect(json.note).toContain('source code');
    expect(json.note).toContain('agentcore deploy');
  });
});
