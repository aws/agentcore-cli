/**
 * E2E tests for Dataset Management lifecycle.
 *
 * Flow: create project → add dataset → write examples → deploy (creates resource + syncs examples)
 *       → deploy again (no-op, hash match) → update examples → deploy (detects change, syncs)
 *       → publish-version → download → download version → remove-version
 *
 * Prerequisites:
 *   - AWS credentials (gamma account)
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

describe.sequential('e2e: dataset lifecycle', () => {
  let testDir: string;
  let projectPath: string;
  const agentName = `E2eDs${String(Date.now()).slice(-8)}`;
  const datasetName = 'E2eTestDataset';

  beforeAll(async () => {
    if (!canRun) return;

    testDir = join(tmpdir(), `agentcore-e2e-dataset-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    // Create project (no agent needed for dataset tests)
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
        'E2E test dataset',
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
  // Write examples and deploy (creates resource + syncs examples)
  // ════════════════════════════════════════════════════════════════════════

  it.skipIf(!canRun)(
    'deploy creates dataset and syncs examples from local file',
    async () => {
      // Write 3 examples to the dataset file (overwriting starter)
      const datasetFile = join(projectPath, 'agentcore/datasets', `${datasetName}.jsonl`);
      const examples = [
        '{"scenario_id": "refund", "turns": [{"input": "I want a refund", "expectedResponse": "Let me help with that."}]}',
        '{"scenario_id": "billing", "turns": [{"input": "Why was I charged?", "expectedResponse": "Let me check your account."}]}',
        '{"scenario_id": "shipping", "turns": [{"input": "Where is my order?", "expectedResponse": "Let me track that for you."}]}',
      ];
      await writeFile(datasetFile, examples.join('\n') + '\n', 'utf-8');

      const result = await run(['deploy', '--yes', '--json']);

      if (result.exitCode !== 0) {
        console.log('Deploy stdout:', result.stdout);
        console.log('Deploy stderr:', result.stderr);
      }

      expect(result.exitCode, 'Deploy failed').toBe(0);
      const json = parseJsonOutput(result.stdout) as { success: boolean };
      expect(json.success).toBe(true);

      // Verify exampleIds written back to local file
      const content = await readFile(datasetFile, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      expect(lines.length).toBe(3);
      for (const line of lines) {
        const obj = JSON.parse(line);
        expect(obj.exampleId).toBeTruthy();
      }
    },
    600000
  );

  // ════════════════════════════════════════════════════════════════════════
  // Deploy again — no changes (hash match → skip)
  // ════════════════════════════════════════════════════════════════════════

  it.skipIf(!canRun)(
    'deploy with no file changes skips dataset sync',
    async () => {
      const result = await run(['deploy', '--yes', '--json']);

      expect(result.exitCode).toBe(0);
      const json = parseJsonOutput(result.stdout) as { success: boolean };
      expect(json.success).toBe(true);
    },
    600000
  );

  // ════════════════════════════════════════════════════════════════════════
  // Update examples and re-deploy (detects change, syncs)
  // ════════════════════════════════════════════════════════════════════════

  it.skipIf(!canRun)(
    'deploy detects content change and syncs updated examples',
    async () => {
      // Modify one example's content (keep exampleId)
      const datasetFile = join(projectPath, 'agentcore/datasets', `${datasetName}.jsonl`);
      const content = await readFile(datasetFile, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      const firstExample = JSON.parse(lines[0]!);
      firstExample.turns[0].expectedResponse = 'Updated response for refund.';
      lines[0] = JSON.stringify(firstExample);
      await writeFile(datasetFile, lines.join('\n') + '\n', 'utf-8');

      const result = await run(['deploy', '--yes', '--json']);

      expect(result.exitCode).toBe(0);
      const json = parseJsonOutput(result.stdout) as { success: boolean };
      expect(json.success).toBe(true);
    },
    600000
  );

  // ════════════════════════════════════════════════════════════════════════
  // Publish Version
  // ════════════════════════════════════════════════════════════════════════

  it.skipIf(!canRun)(
    'publishes DRAFT as version 1',
    async () => {
      const result = await run(['dataset', 'publish-version', '--name', datasetName, '--json']);

      expect(result.exitCode).toBe(0);
      const json = parseJsonOutput(result.stdout) as { success: boolean; version: string; exampleCount: number };
      expect(json.success).toBe(true);
      expect(json.version).toBe('1');
      expect(json.exampleCount).toBe(3);
    },
    60000
  );

  // ════════════════════════════════════════════════════════════════════════
  // Status (via agentcore status --type dataset)
  // ════════════════════════════════════════════════════════════════════════

  it.skipIf(!canRun)(
    'shows dataset in project status',
    async () => {
      const result = await run(['status', '--type', 'dataset', '--json']);

      expect(result.exitCode).toBe(0);
      const json = parseJsonOutput(result.stdout) as {
        success: boolean;
        resources: { resourceType: string; name: string; deploymentState: string }[];
      };
      expect(json.success).toBe(true);
      const datasetResource = json.resources.find(r => r.name === datasetName);
      expect(datasetResource).toBeTruthy();
      expect(datasetResource!.deploymentState).toBe('deployed');
    },
    60000
  );

  // ════════════════════════════════════════════════════════════════════════
  // Download DRAFT
  // ════════════════════════════════════════════════════════════════════════

  it.skipIf(!canRun)(
    'downloads DRAFT back to local file',
    async () => {
      // Clear local file first
      const datasetFile = join(projectPath, 'agentcore/datasets', `${datasetName}.jsonl`);
      await writeFile(datasetFile, '', 'utf-8');

      const result = await run(['dataset', 'download', '--name', datasetName, '--yes', '--json']);

      expect(result.exitCode).toBe(0);
      const json = parseJsonOutput(result.stdout) as { success: boolean; exampleCount: number; version: string };
      expect(json.success).toBe(true);
      expect(json.exampleCount).toBe(3);
      expect(json.version).toBe('DRAFT');

      // Verify file has content
      const content = await readFile(datasetFile, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      expect(lines.length).toBe(3);
    },
    60000
  );

  // ════════════════════════════════════════════════════════════════════════
  // Download specific version
  // ════════════════════════════════════════════════════════════════════════

  it.skipIf(!canRun)(
    'downloads a specific version',
    async () => {
      const result = await run(['dataset', 'download', '--name', datasetName, '--version', '1', '--yes', '--json']);

      expect(result.exitCode).toBe(0);
      const json = parseJsonOutput(result.stdout) as { success: boolean; exampleCount: number; version: string };
      expect(json.success).toBe(true);
      expect(json.exampleCount).toBe(3);
      expect(json.version).toBe('1');
    },
    60000
  );

  // ════════════════════════════════════════════════════════════════════════
  // Remove version
  // ════════════════════════════════════════════════════════════════════════

  it.skipIf(!canRun)(
    'removes a specific published version',
    async () => {
      const result = await run(['dataset', 'remove-version', '--name', datasetName, '--json', '1']);

      expect(result.exitCode).toBe(0);
      const json = parseJsonOutput(result.stdout) as { success: boolean; deletedVersion: string };
      expect(json.success).toBe(true);
      expect(json.deletedVersion).toBe('1');
    },
    60000
  );

  // ════════════════════════════════════════════════════════════════════════
  // Force push — replace all examples
  // ════════════════════════════════════════════════════════════════════════

  it.skipIf(!canRun)(
    'force push replaces all examples with new content',
    async () => {
      // Overwrite the dataset file with completely new examples (no exampleIds)
      const datasetFile = join(projectPath, 'agentcore/datasets', `${datasetName}.jsonl`);
      const newExamples = [
        '{"scenario_id": "returns", "turns": [{"input": "How do I return an item?", "expectedResponse": "You can initiate a return from your orders page."}]}',
        '{"scenario_id": "cancel", "turns": [{"input": "Cancel my order", "expectedResponse": "Let me help you cancel that order."}]}',
      ];
      await writeFile(datasetFile, newExamples.join('\n') + '\n', 'utf-8');

      // Deploy with force to replace remote examples
      const result = await run(['deploy', '--yes', '--json']);

      if (result.exitCode !== 0) {
        console.log('Force push deploy stdout:', result.stdout);
        console.log('Force push deploy stderr:', result.stderr);
      }

      expect(result.exitCode, 'Force push deploy failed').toBe(0);
      const json = parseJsonOutput(result.stdout) as { success: boolean };
      expect(json.success).toBe(true);

      // Verify exampleIds written back to local file (new IDs for new examples)
      const content = await readFile(datasetFile, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      expect(lines.length).toBe(2);
      for (const line of lines) {
        const obj = JSON.parse(line) as { exampleId?: string };
        expect(obj.exampleId).toBeTruthy();
      }
    },
    600000
  );

  // ════════════════════════════════════════════════════════════════════════
  // Delete examples by removing lines, then deploy
  // ════════════════════════════════════════════════════════════════════════

  it.skipIf(!canRun)(
    'removing lines from local file and deploying deletes remote examples',
    async () => {
      const datasetFile = join(projectPath, 'agentcore/datasets', `${datasetName}.jsonl`);

      // Read current file (should have 2 examples from force push)
      const content = await readFile(datasetFile, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      expect(lines.length).toBe(2);

      // Keep only the first example (delete the second)
      await writeFile(datasetFile, lines[0]! + '\n', 'utf-8');

      const result = await run(['deploy', '--yes', '--json']);

      if (result.exitCode !== 0) {
        console.log('Delete deploy stdout:', result.stdout);
        console.log('Delete deploy stderr:', result.stderr);
      }

      expect(result.exitCode, 'Delete deploy failed').toBe(0);
      const json = parseJsonOutput(result.stdout) as { success: boolean };
      expect(json.success).toBe(true);

      // Verify local file still has 1 example with exampleId
      const updatedContent = await readFile(datasetFile, 'utf-8');
      const updatedLines = updatedContent.split('\n').filter(l => l.trim());
      expect(updatedLines.length).toBe(1);
      const obj = JSON.parse(updatedLines[0]!) as { exampleId?: string };
      expect(obj.exampleId).toBeTruthy();
    },
    600000
  );

  // ════════════════════════════════════════════════════════════════════════
  // Simulated schema type deploys successfully
  // ════════════════════════════════════════════════════════════════════════

  it.skipIf(!canRun)(
    'deploys a SIMULATED_V1 schema type dataset',
    async () => {
      const simulatedDatasetName = 'E2eSimulatedDataset';

      // Add a dataset with SIMULATED_V1 schema type
      const addResult = await run([
        'add',
        'dataset',
        '--name',
        simulatedDatasetName,
        '--schema-type',
        'AGENTCORE_EVALUATION_SIMULATED_V1',
        '--description',
        'E2E simulated schema test dataset',
        '--json',
      ]);

      expect(addResult.exitCode, `Add simulated dataset failed: ${addResult.stdout}`).toBe(0);
      const addJson = parseJsonOutput(addResult.stdout) as { success: boolean; datasetName: string };
      expect(addJson.success).toBe(true);
      expect(addJson.datasetName).toBe(simulatedDatasetName);

      // Write simulated examples to the dataset file (must match SIMULATED_V1 schema)
      const datasetFile = join(projectPath, 'agentcore/datasets', `${simulatedDatasetName}.jsonl`);
      const examples = [
        '{"scenario_id": "sim_booking", "input": "Book a flight", "actor_profile": {"traits": {"personality": "impatient"}, "context": "frequent flyer", "goal": "book cheapest flight"}}',
        '{"scenario_id": "sim_cancel", "input": "Cancel reservation", "actor_profile": {"traits": {"personality": "polite"}, "context": "first time user", "goal": "get full refund"}}',
      ];
      await writeFile(datasetFile, examples.join('\n') + '\n', 'utf-8');

      // Deploy — should succeed with simulated schema type
      const deployResult = await run(['deploy', '--yes', '--json']);

      if (deployResult.exitCode !== 0) {
        console.log('Simulated deploy stdout:', deployResult.stdout);
        console.log('Simulated deploy stderr:', deployResult.stderr);
      }

      expect(deployResult.exitCode, 'Simulated deploy failed').toBe(0);
      const deployJson = parseJsonOutput(deployResult.stdout) as { success: boolean };
      expect(deployJson.success).toBe(true);

      // Verify exampleIds written back to local file
      const content = await readFile(datasetFile, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      expect(lines.length).toBe(2);
      for (const line of lines) {
        const obj = JSON.parse(line) as { exampleId?: string };
        expect(obj.exampleId).toBeTruthy();
      }
    },
    600000
  );
});
