import { hasAwsCredentials, runCLI } from '../src/test-utils/index.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Regression test for non-interactive deploy on a freshly-created project.
 *
 * `agentcore create` writes an empty aws-targets.json by design (the target is
 * populated at deploy time). The interactive deploy prompts for it; the
 * non-interactive deploy path (`--yes`/`--json`/`--target`) must auto-populate a
 * default target from the detected AWS context instead of failing with
 * `Target "default" not found`.
 */
describe('integration: non-interactive deploy auto-populates aws-targets', () => {
  let testDir: string;
  let projectDir: string;

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-deploy-autopop-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    const name = `AutoPop${Date.now().toString().slice(-6)}`;
    const result = await runCLI(['create', '--name', name, '--no-agent', '--json'], testDir);
    expect(result.exitCode, `create failed: ${result.stderr}`).toBe(0);
    projectDir = join(testDir, name);
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('create leaves aws-targets.json empty', async () => {
    const targets = JSON.parse(await readFile(join(projectDir, 'agentcore', 'aws-targets.json'), 'utf-8'));
    expect(targets).toEqual([]);
  });

  it('non-interactive deploy does not fail with "target not found"', async () => {
    // --dry-run avoids real CDK deploy; the target lookup (and our auto-populate)
    // still runs first. The key assertion: deploy must NOT bail with the
    // pre-fix "Target default not found" error.
    const result = await runCLI(['deploy', '--json', '--dry-run'], projectDir);

    const combined = `${result.stdout}\n${result.stderr}`;
    expect(combined.toLowerCase()).not.toContain('not found in aws-targets.json');
    expect(combined.toLowerCase()).not.toContain('target "default" not found');
  });

  it.skipIf(!hasAwsCredentials())(
    'auto-populates a default target from AWS context when credentials are available',
    async () => {
      await runCLI(['deploy', '--json', '--dry-run'], projectDir);

      const targets = JSON.parse(await readFile(join(projectDir, 'agentcore', 'aws-targets.json'), 'utf-8'));
      expect(Array.isArray(targets)).toBe(true);
      expect(targets.length).toBeGreaterThan(0);
      expect(targets[0].name).toBe('default');
      expect(targets[0].account).toMatch(/^\d{12}$/);
      expect(typeof targets[0].region).toBe('string');
    }
  );
});
