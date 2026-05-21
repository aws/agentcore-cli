import { runCLI } from '../../../../test-utils/index.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('add dataset command', () => {
  let testDir: string;
  let projectDir: string;

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-add-dataset-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    // Create project
    const projectName = 'DatasetProj';
    const result = await runCLI(['create', '--name', projectName, '--no-agent'], testDir);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create project: ${result.stdout} ${result.stderr}`);
    }
    projectDir = join(testDir, projectName);
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('validation', () => {
    it('requires name flag', async () => {
      const result = await runCLI(['add', 'dataset', '--json'], projectDir);
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error.includes('--name'), `Error: ${json.error}`).toBeTruthy();
    });
  });

  describe('dataset creation', () => {
    it('creates dataset as top-level resource', async () => {
      const datasetName = `dataset${Date.now()}`;
      const result = await runCLI(
        ['add', 'dataset', '--name', datasetName, '--schema-type', 'AGENTCORE_EVALUATION_PREDEFINED_V1', '--json'],
        projectDir
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.datasetName).toBe(datasetName);

      // Verify in agentcore.json as top-level resource
      const projectSpec = JSON.parse(await readFile(join(projectDir, 'agentcore/agentcore.json'), 'utf-8'));
      const dataset = projectSpec.datasets.find((d: { name: string }) => d.name === datasetName);
      expect(dataset, 'Dataset should be in project datasets').toBeTruthy();
    });

    it('creates dataset with description', async () => {
      const datasetName = `dsdesc${Date.now()}`;
      const result = await runCLI(
        [
          'add',
          'dataset',
          '--name',
          datasetName,
          '--schema-type',
          'AGENTCORE_EVALUATION_PREDEFINED_V1',
          '--description',
          'My test dataset',
          '--json',
        ],
        projectDir
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);

      // Verify description
      const projectSpec = JSON.parse(await readFile(join(projectDir, 'agentcore/agentcore.json'), 'utf-8'));
      const dataset = projectSpec.datasets.find((d: { name: string }) => d.name === datasetName);
      expect(dataset?.description).toBe('My test dataset');
    });

    it('rejects duplicate dataset names', async () => {
      const datasetName = `dsdup${Date.now()}`;
      // Create first
      await runCLI(
        ['add', 'dataset', '--name', datasetName, '--schema-type', 'AGENTCORE_EVALUATION_PREDEFINED_V1', '--json'],
        projectDir
      );
      // Try duplicate
      const result = await runCLI(
        ['add', 'dataset', '--name', datasetName, '--schema-type', 'AGENTCORE_EVALUATION_PREDEFINED_V1', '--json'],
        projectDir
      );
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
    });
  });
});
