import { runCLI } from '../../../../test-utils/index.js';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Knowledge bases (FMKB) are gated behind ENABLE_GATED_FEATURES. `agentcore run
 * ingest` operates exclusively on knowledge bases, so it must be gated to match
 * `add knowledge-base` / `remove knowledge-base`. These tests drive the built
 * CLI so we exercise the actual commander registration (hidden command + the
 * in-action guard).
 */
describe('run ingest command — FMKB gating', () => {
  let testDir: string;
  let projectDir: string;

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-run-ingest-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
    const projectName = 'TestProj';
    // Create the project with gated features enabled so the KB add path is
    // available; the ingest gating is exercised separately below.
    const result = await runCLI(['create', '--name', projectName, '--no-agent'], testDir);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create project: ${result.stdout} ${result.stderr}`);
    }
    projectDir = join(testDir, projectName);
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('rejects `run ingest` when ENABLE_GATED_FEATURES is not set', async () => {
    const result = await runCLI(['run', 'ingest', '--name', 'kb-default', '--json'], projectDir);
    expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(1);
    expect(result.stderr).toContain('Knowledge bases are not yet available.');
  });

  it('hides `ingest` from `run --help` when ENABLE_GATED_FEATURES is not set', async () => {
    const result = await runCLI(['run', '--help'], projectDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('ingest');
  });

  it('exposes `ingest` in `run --help` when ENABLE_GATED_FEATURES=1', async () => {
    const result = await runCLI(['run', '--help'], projectDir, { env: { ENABLE_GATED_FEATURES: '1' } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('ingest');
  });

  it('passes the gate (fails later on validation) when ENABLE_GATED_FEATURES=1', async () => {
    // With the gate open, the command proceeds past the FMKB guard. We pass an
    // unknown KB name so it fails on the validation step rather than the gate —
    // proving the gate no longer blocks the command.
    const result = await runCLI(['run', 'ingest', '--name', 'does-not-exist', '--json'], projectDir, {
      env: { ENABLE_GATED_FEATURES: '1' },
    });
    expect(result.exitCode).toBe(1);
    const combined = `${result.stdout} ${result.stderr}`;
    expect(combined).not.toContain('Knowledge bases are not yet available.');
    expect(combined).toContain('does-not-exist');
  });
});
