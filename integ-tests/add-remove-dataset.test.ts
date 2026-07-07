/**
 * Integration tests for dataset add/remove lifecycle.
 *
 * Verifies:
 * - `agentcore add dataset` scaffolds .jsonl and updates agentcore.json
 * - `agentcore remove dataset` removes from agentcore.json
 * - Schema type validation
 * - Config.managed.location is set correctly
 */
import { parseJsonOutput, runCLI } from '../src/test-utils/index.js';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('add/remove dataset', () => {
  let testDir: string;
  let projectDir: string;

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-dataset-integ-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    const result = await runCLI(['create', '--name', 'DatasetInteg', '--no-agent'], testDir);
    expect(result.exitCode, `Create failed: ${result.stdout} ${result.stderr}`).toBe(0);
    projectDir = join(testDir, 'DatasetInteg');
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('adds a predefined dataset with scaffolded file', async () => {
    const result = await runCLI(
      ['add', 'dataset', '--name', 'MyPredefined', '--schema-type', 'AGENTCORE_EVALUATION_PREDEFINED_V1', '--json'],
      projectDir
    );

    expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
    const json = parseJsonOutput(result.stdout) as { success: boolean; datasetName: string; location: string };
    expect(json.success).toBe(true);
    expect(json.datasetName).toBe('MyPredefined');
    expect(json.location).toBe('agentcore/datasets/MyPredefined.jsonl');

    // Verify agentcore.json
    const spec = JSON.parse(await readFile(join(projectDir, 'agentcore/agentcore.json'), 'utf-8'));
    const dataset = spec.datasets.find((d: { name: string }) => d.name === 'MyPredefined');
    expect(dataset).toBeTruthy();
    expect(dataset.schemaType).toBe('AGENTCORE_EVALUATION_PREDEFINED_V1');
    expect(dataset.config.managed.location).toBe('datasets/MyPredefined.jsonl');

    // Verify .jsonl file was scaffolded
    const jsonlPath = join(projectDir, 'agentcore/datasets/MyPredefined.jsonl');
    expect(existsSync(jsonlPath)).toBe(true);
    const content = await readFile(jsonlPath, 'utf-8');
    expect(content).toContain('scenario_id');
    expect(content).toContain('turns');
  });

  it('adds a simulated dataset with correct starter', async () => {
    const result = await runCLI(
      ['add', 'dataset', '--name', 'MySimulated', '--schema-type', 'AGENTCORE_EVALUATION_SIMULATED_V1', '--json'],
      projectDir
    );

    expect(result.exitCode).toBe(0);

    const jsonlPath = join(projectDir, 'agentcore/datasets/MySimulated.jsonl');
    expect(existsSync(jsonlPath)).toBe(true);
    const content = await readFile(jsonlPath, 'utf-8');
    expect(content).toContain('actor_profile');
    expect(content).toContain('max_turns');
  });

  it('rejects invalid schema type', async () => {
    const result = await runCLI(
      ['add', 'dataset', '--name', 'BadType', '--schema-type', 'INVALID_TYPE', '--json'],
      projectDir
    );

    expect(result.exitCode).toBe(1);
    const json = parseJsonOutput(result.stdout) as { success: boolean; error: string };
    expect(json.success).toBe(false);
  });

  it('rejects duplicate dataset name', async () => {
    const result = await runCLI(
      ['add', 'dataset', '--name', 'MyPredefined', '--schema-type', 'AGENTCORE_EVALUATION_PREDEFINED_V1', '--json'],
      projectDir
    );

    expect(result.exitCode).toBe(1);
    const json = parseJsonOutput(result.stdout) as { success: boolean; error: string };
    expect(json.success).toBe(false);
    expect(json.error).toContain('already exists');
  });

  it('adds dataset with description', async () => {
    const result = await runCLI(
      [
        'add',
        'dataset',
        '--name',
        'Described',
        '--schema-type',
        'AGENTCORE_EVALUATION_PREDEFINED_V1',
        '--description',
        'Test scenarios for billing',
        '--json',
      ],
      projectDir
    );

    expect(result.exitCode).toBe(0);

    const spec = JSON.parse(await readFile(join(projectDir, 'agentcore/agentcore.json'), 'utf-8'));
    const dataset = spec.datasets.find((d: { name: string }) => d.name === 'Described');
    expect(dataset.description).toBe('Test scenarios for billing');
  });

  it('adds dataset with --kms-key-arn and persists to agentcore.json', async () => {
    const result = await runCLI(
      [
        'add',
        'dataset',
        '--name',
        'KmsDataset',
        '--schema-type',
        'AGENTCORE_EVALUATION_PREDEFINED_V1',
        '--kms-key-arn',
        'arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012',
        '--json',
      ],
      projectDir
    );

    expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
    const json = parseJsonOutput(result.stdout) as { success: boolean; datasetName: string };
    expect(json.success).toBe(true);
    expect(json.datasetName).toBe('KmsDataset');

    const spec = JSON.parse(await readFile(join(projectDir, 'agentcore/agentcore.json'), 'utf-8'));
    const dataset = spec.datasets.find((d: { name: string }) => d.name === 'KmsDataset');
    expect(dataset.kmsKeyArn).toBe('arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012');
  });

  it('rejects invalid --kms-key-arn', async () => {
    const result = await runCLI(
      [
        'add',
        'dataset',
        '--name',
        'BadKms',
        '--schema-type',
        'AGENTCORE_EVALUATION_PREDEFINED_V1',
        '--kms-key-arn',
        'not-a-valid-arn',
        '--json',
      ],
      projectDir
    );

    expect(result.exitCode).toBe(1);
    const json = parseJsonOutput(result.stdout) as { success: boolean; error: string };
    expect(json.success).toBe(false);
    expect(json.error).toContain('kms-key-arn');
  });

  it('omits kmsKeyArn from agentcore.json when not provided', async () => {
    const result = await runCLI(
      ['add', 'dataset', '--name', 'NoKms', '--schema-type', 'AGENTCORE_EVALUATION_PREDEFINED_V1', '--json'],
      projectDir
    );

    expect(result.exitCode).toBe(0);

    const spec = JSON.parse(await readFile(join(projectDir, 'agentcore/agentcore.json'), 'utf-8'));
    const dataset = spec.datasets.find((d: { name: string }) => d.name === 'NoKms');
    expect(dataset).toBeTruthy();
    expect(dataset.kmsKeyArn).toBeUndefined();
    expect('kmsKeyArn' in dataset).toBe(false);
  });

  it('removes a dataset', async () => {
    const result = await runCLI(['remove', 'dataset', '--name', 'MyPredefined', '--json'], projectDir);

    expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
    const json = parseJsonOutput(result.stdout) as { success: boolean };
    expect(json.success).toBe(true);

    // Verify removed from agentcore.json
    const spec = JSON.parse(await readFile(join(projectDir, 'agentcore/agentcore.json'), 'utf-8'));
    const dataset = spec.datasets.find((d: { name: string }) => d.name === 'MyPredefined');
    expect(dataset).toBeUndefined();
  });

  it('remove fails for non-existent dataset', async () => {
    const result = await runCLI(['remove', 'dataset', '--name', 'NonExistent', '--json'], projectDir);

    expect(result.exitCode).toBe(1);
    const json = parseJsonOutput(result.stdout) as { success: boolean; error: string };
    expect(json.success).toBe(false);
    expect(json.error).toContain('not found');
  });

  it('rejects empty name', async () => {
    const result = await runCLI(
      ['add', 'dataset', '--name', '', '--schema-type', 'AGENTCORE_EVALUATION_PREDEFINED_V1', '--json'],
      projectDir
    );

    expect(result.exitCode).toBe(1);
    const json = parseJsonOutput(result.stdout) as { success: boolean; error: string };
    expect(json.success).toBe(false);
  });

  it('rejects name starting with a digit', async () => {
    const result = await runCLI(
      ['add', 'dataset', '--name', '1invalid', '--schema-type', 'AGENTCORE_EVALUATION_PREDEFINED_V1', '--json'],
      projectDir
    );

    expect(result.exitCode).toBe(1);
    const json = parseJsonOutput(result.stdout) as { success: boolean; error: string };
    expect(json.success).toBe(false);
    expect(json.error).toContain('Must begin with a letter');
  });

  it('predefined .jsonl content is valid JSON lines with scenario_id and turns', async () => {
    const jsonlPath = join(projectDir, 'agentcore/datasets/Described.jsonl');
    expect(existsSync(jsonlPath)).toBe(true);

    const content = await readFile(jsonlPath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBeGreaterThan(0);

    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty('scenario_id');
      expect(parsed).toHaveProperty('turns');
      expect(Array.isArray(parsed.turns)).toBe(true);
    }
  });

  it('simulated .jsonl content is valid JSON lines with actor_profile and max_turns', async () => {
    const jsonlPath = join(projectDir, 'agentcore/datasets/MySimulated.jsonl');
    expect(existsSync(jsonlPath)).toBe(true);

    const content = await readFile(jsonlPath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBeGreaterThan(0);

    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty('actor_profile');
      expect(parsed).toHaveProperty('max_turns');
    }
  });

  it('remove does NOT delete local .jsonl file', async () => {
    // Add a dataset specifically for this test
    const addResult = await runCLI(
      ['add', 'dataset', '--name', 'FileKeep', '--schema-type', 'AGENTCORE_EVALUATION_PREDEFINED_V1', '--json'],
      projectDir
    );
    expect(addResult.exitCode).toBe(0);

    const jsonlPath = join(projectDir, 'agentcore/datasets/FileKeep.jsonl');
    expect(existsSync(jsonlPath)).toBe(true);

    // Remove the dataset
    const removeResult = await runCLI(['remove', 'dataset', '--name', 'FileKeep', '--json'], projectDir);
    expect(removeResult.exitCode).toBe(0);

    // .jsonl file should still exist
    expect(existsSync(jsonlPath)).toBe(true);
  });
});
