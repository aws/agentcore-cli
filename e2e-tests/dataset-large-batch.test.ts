/**
 * E2E tests for Dataset large batch upload (1000 examples — service maximum).
 *
 * Flow: create project (no agent) → add dataset → write 1000 examples
 *       → deploy (pushes full batch in single API call)
 *       → verify exampleIds on ALL 1000 lines → re-deploy (no-op hash match)
 *
 * Prerequisites:
 *   - AWS credentials
 *   - npm, git, uv installed
 */
import { parseJsonOutput } from '../src/test-utils/index.js';
import {
  baseCanRun,
  hasAws,
  installCdkTarball,
  runAgentCoreCLI,
  teardownE2EProject,
  writeAwsTargets,
} from './e2e-helper.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const canRun = baseCanRun && hasAws;

describe.sequential('e2e: dataset large batch', () => {
  let testDir: string;
  let projectPath: string;
  const agentName = `E2eDsBatch${String(Date.now()).slice(-8)}`;
  const datasetName = 'E2eLargeBatchDataset';
  const EXAMPLE_COUNT = 1000;

  beforeAll(async () => {
    if (!canRun) return;

    testDir = join(tmpdir(), `agentcore-e2e-dataset-batch-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    // Create project (no agent needed for dataset-only tests)
    const result = await runAgentCoreCLI(['create', '--name', agentName, '--no-agent', '--json'], testDir);
    expect(result.exitCode, `Create failed: ${result.stderr}`).toBe(0);
    projectPath = (parseJsonOutput(result.stdout) as { projectPath: string }).projectPath;

    await writeAwsTargets(projectPath);
    installCdkTarball(projectPath);
  }, 300000);

  afterAll(async () => {
    if (projectPath && hasAws) {
      await teardownE2EProject(projectPath, agentName, 'Bedrock');
    }
    if (testDir) await rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 1000 });
  }, 600000);

  const run = (args: string[]) => runAgentCoreCLI(args, projectPath);

  // ════════════════════════════════════════════════════════════════════════
  // Add dataset
  // ════════════════════════════════════════════════════════════════════════

  it.skipIf(!canRun)(
    'adds a dataset to the project',
    async () => {
      const result = await run([
        'add',
        'dataset',
        '--name',
        datasetName,
        '--schema-type',
        'AGENTCORE_EVALUATION_PREDEFINED_V1',
        '--description',
        'E2E large batch test dataset',
        '--json',
      ]);

      expect(result.exitCode, `Add failed: ${result.stdout}`).toBe(0);
      const json = parseJsonOutput(result.stdout) as { success: boolean; datasetName: string; location: string };
      expect(json.success).toBe(true);
      expect(json.datasetName).toBe(datasetName);
      expect(json.location).toContain('.jsonl');
    },
    60000
  );

  // ════════════════════════════════════════════════════════════════════════
  // Write 1000 examples and deploy
  // ════════════════════════════════════════════════════════════════════════

  it.skipIf(!canRun)(
    'deploy creates dataset and syncs 1000 examples',
    async () => {
      const datasetFile = join(projectPath, 'agentcore/datasets', `${datasetName}.jsonl`);

      // Generate 1050 JSONL examples programmatically
      const examples: string[] = [];
      for (let i = 0; i < EXAMPLE_COUNT; i++) {
        examples.push(
          JSON.stringify({
            scenario_id: `s_${i}`,
            turns: [{ input: `test ${i}` }],
          })
        );
      }
      await writeFile(datasetFile, examples.join('\n') + '\n', 'utf-8');

      const result = await run(['deploy', '--yes', '--json']);

      if (result.exitCode !== 0) {
        console.log('Deploy stdout:', result.stdout);
        console.log('Deploy stderr:', result.stderr);
      }

      expect(result.exitCode, 'Deploy failed').toBe(0);
      const json = parseJsonOutput(result.stdout) as { success: boolean };
      expect(json.success).toBe(true);

      // Verify exampleIds written back to ALL 1050 lines
      const content = await readFile(datasetFile, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      expect(lines.length).toBe(EXAMPLE_COUNT);
      for (let i = 0; i < lines.length; i++) {
        const obj = JSON.parse(lines[i]!) as { exampleId?: string };
        expect(obj.exampleId, `Line ${i} should have exampleId`).toBeTruthy();
      }
    },
    600000
  );

  // ════════════════════════════════════════════════════════════════════════
  // Re-deploy with no changes — verify no-op (hash match)
  // ════════════════════════════════════════════════════════════════════════

  it.skipIf(!canRun)(
    'deploy with no file changes skips dataset sync (hash match)',
    async () => {
      const result = await run(['deploy', '--yes', '--json']);

      expect(result.exitCode).toBe(0);
      const json = parseJsonOutput(result.stdout) as { success: boolean };
      expect(json.success).toBe(true);
    },
    600000
  );
});
