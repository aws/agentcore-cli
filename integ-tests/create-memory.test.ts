/* eslint-disable security/detect-non-literal-fs-filename */
import { prereqs, readProjectConfig, runCLI } from '../src/test-utils/index.js';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe.skipIf(!prereqs.npm || !prereqs.git)('integration: create with memory options', () => {
  let testDir: string;

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-integ-memory-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('creates project with shortTerm memory', async () => {
    const name = `ST${Date.now().toString().slice(-6)}`;
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
        'shortTerm',
        '--json',
      ],
      testDir
    );

    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.success).toBe(true);

    // Verify agentcore.json has memory configuration
    const config = await readProjectConfig(json.projectPath);
    const memories = config.memories as Record<string, unknown>[] | undefined;
    expect(memories, 'memories should exist in config').toBeDefined();
    expect(memories!.length).toBeGreaterThan(0);
  });

  it('creates project with longAndShortTerm memory', async () => {
    const name = `LST${Date.now().toString().slice(-6)}`;
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
        'longAndShortTerm',
        '--json',
      ],
      testDir
    );

    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.success).toBe(true);

    // Verify agentcore.json has memory configuration with multiple strategies
    const config = await readProjectConfig(json.projectPath);
    const memories = config.memories as Record<string, unknown>[] | undefined;
    expect(memories, 'memories should exist in config').toBeDefined();
    expect(memories!.length).toBeGreaterThan(0);

    // longAndShortTerm should have strategies defined
    const memory = memories![0]!;
    const strategies = memory.strategies as Record<string, unknown>[] | undefined;
    expect(strategies, 'memory should have strategies').toBeDefined();
    expect(strategies!.length).toBeGreaterThanOrEqual(2);
  });
});
