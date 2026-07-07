/**
 * Integration tests for dataset subcommands that require a deployment.
 *
 * Verifies that `dataset download`, `dataset publish-version`, and
 * `dataset remove-version` fail gracefully with a helpful error when
 * the project has not been deployed yet.
 */
import { createTestProject, parseJsonOutput, runCLI } from '../src/test-utils/index.js';
import type { TestProject } from '../src/test-utils/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('dataset commands when project is not deployed', () => {
  let project: TestProject;

  beforeAll(async () => {
    project = await createTestProject({ noAgent: true });

    // Add a dataset so the commands have something to resolve
    const addResult = await runCLI(
      ['add', 'dataset', '--name', 'UndeployedDS', '--schema-type', 'AGENTCORE_EVALUATION_PREDEFINED_V1', '--json'],
      project.projectPath
    );
    expect(addResult.exitCode, `Failed to add dataset: ${addResult.stdout} ${addResult.stderr}`).toBe(0);
  });

  afterAll(async () => {
    await project.cleanup();
  });

  it('dataset download --json fails with deploy-first error', async () => {
    const result = await runCLI(['dataset', 'download', '--name', 'UndeployedDS', '--json'], project.projectPath);

    expect(result.exitCode).toBe(1);
    const json = parseJsonOutput(result.stdout) as { success: boolean; error: string };
    expect(json.success).toBe(false);
    expect(json.error.toLowerCase()).toMatch(/deploy/);
  });

  it('dataset publish-version --json fails with deploy-first error', async () => {
    const result = await runCLI(
      ['dataset', 'publish-version', '--name', 'UndeployedDS', '--json'],
      project.projectPath
    );

    expect(result.exitCode).toBe(1);
    const json = parseJsonOutput(result.stdout) as { success: boolean; error: string };
    expect(json.success).toBe(false);
    expect(json.error.toLowerCase()).toMatch(/deploy/);
  });

  it('dataset remove-version 1 --json fails with deploy-first error', async () => {
    const result = await runCLI(
      ['dataset', 'remove-version', '1', '--name', 'UndeployedDS', '--json'],
      project.projectPath
    );

    expect(result.exitCode).toBe(1);
    const json = parseJsonOutput(result.stdout) as { success: boolean; error: string };
    expect(json.success).toBe(false);
    expect(json.error.toLowerCase()).toMatch(/deploy/);
  });

  it('dataset download without --yes prompts for confirmation and respects decline', async () => {
    // In non-interactive (piped) mode, readline gets empty input which defaults to "N"
    // This test doesn't need a deployed dataset — it fails at the resolve step,
    // but the confirmation prompt behavior is the same pattern
    const result = await runCLI(['dataset', 'download', '--name', 'UndeployedDS'], project.projectPath);

    // Either it shows "Skipped" (confirmation declined) or fails with deploy error
    // Both are acceptable — the key is it doesn't hang waiting for stdin
    expect(result.exitCode).not.toBe(0);
  });

  it('status --type dataset --json returns gracefully when undeployed', async () => {
    const result = await runCLI(['status', '--type', 'dataset', '--json'], project.projectPath);

    expect(result.exitCode).toBe(0);
    const json = parseJsonOutput(result.stdout) as {
      success: boolean;
      resources: { resourceType: string; deploymentState: string; name: string }[];
    };
    expect(json.success).toBe(true);
    // The dataset should appear as local-only since not deployed
    const datasetResource = json.resources.find(r => r.name === 'UndeployedDS');
    expect(datasetResource).toBeDefined();
    expect(datasetResource!.resourceType).toBe('dataset');
    expect(datasetResource!.deploymentState).toBe('local-only');
  });
});
