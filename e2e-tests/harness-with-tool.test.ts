/**
 * E2E test: a Bedrock harness with an attached tool.
 *
 * Tool wiring (`add tool`) only fails at CloudFormation synth/deploy, not at local
 * validation, so this proves the tool config survives a real deploy. Uses
 * agentcore_code_interpreter because it needs no external ARN — the service provisions
 * a default code interpreter — keeping the test self-contained.
 *
 * create → add tool → deploy → invoke → status → teardown.
 *
 * Requires: AWS credentials, npm, git.
 */
import { hasAwsCredentials, parseJsonOutput, prereqs, retry, spawnAndCollect } from '../src/test-utils/index.js';
import { installCdkTarball, runAgentCoreCLI, teardownE2EProject, writeAwsTargets } from './e2e-helper.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const hasAws = hasAwsCredentials();
const canRun = prereqs.npm && prereqs.git && hasAws;

describe.sequential('e2e: harness with tool — create → add tool → deploy → invoke → teardown', () => {
  let testDir: string;
  let projectPath: string;
  let harnessName: string;
  const toolName = 'codeRunner';

  beforeAll(async () => {
    if (!canRun) return;

    testDir = join(tmpdir(), `agentcore-e2e-harness-tool-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    harnessName = `E2eHrnsTool${String(Date.now()).slice(-8)}`;

    const result = await runAgentCoreCLI(
      ['create', '--name', harnessName, '--model-provider', 'bedrock', '--json', '--skip-git'],
      testDir
    );
    expect(result.exitCode, `Create failed: ${result.stderr}`).toBe(0);
    const json = parseJsonOutput(result.stdout) as { projectPath: string };
    projectPath = json.projectPath;

    // Attach a code-interpreter tool (no external ARN required).
    const addToolResult = await runAgentCoreCLI(
      ['add', 'tool', '--harness', harnessName, '--type', 'agentcore_code_interpreter', '--name', toolName, '--json'],
      projectPath
    );
    expect(addToolResult.exitCode, `Add tool failed: ${addToolResult.stderr}`).toBe(0);

    await writeAwsTargets(projectPath);
    installCdkTarball(projectPath);
  }, 300000);

  afterAll(async () => {
    if (projectPath && hasAws) {
      await teardownE2EProject(projectPath, harnessName, 'bedrock').catch((_: unknown) => undefined);
    }
    if (testDir) await rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 1000 });
  }, 600000);

  it.skipIf(!canRun)(
    'tool is recorded in the harness spec before deploy',
    async () => {
      const specPath = join(projectPath, 'app', harnessName, 'harness.json');
      const spec = JSON.parse(await readFile(specPath, 'utf-8')) as {
        tools: { type: string; name: string }[];
      };
      const tool = spec.tools.find(t => t.name === toolName);
      expect(tool, `Tool "${toolName}" should be in harness.json`).toBeDefined();
      expect(tool!.type).toBe('agentcore_code_interpreter');
    },
    30000
  );

  it.skipIf(!canRun)(
    'deploys the harness with its tool',
    async () => {
      expect(projectPath, 'Project should have been created').toBeTruthy();

      await retry(
        async () => {
          const result = await runAgentCoreCLI(['deploy', '--yes', '--json'], projectPath);
          expect(result.exitCode, `Deploy failed stderr=${result.stderr}, stdout=${result.stdout}`).toBe(0);
          const json = parseJsonOutput(result.stdout) as { success: boolean };
          expect(json.success, 'Deploy should report success').toBe(true);
        },
        1,
        30000
      );
    },
    600000
  );

  it.skipIf(!canRun)(
    'invokes the deployed harness',
    async () => {
      await retry(
        async () => {
          const result = await runAgentCoreCLI(
            ['invoke', '--harness', harnessName, '--prompt', 'Say hello', '--json'],
            projectPath
          );
          expect(result.exitCode, `Invoke failed: stderr=${result.stderr}, stdout=${result.stdout}`).toBe(0);
          const json = parseJsonOutput(result.stdout) as { success: boolean };
          expect(json.success, 'Invoke should report success').toBe(true);
        },
        3,
        15000
      );
    },
    180000
  );

  it.skipIf(!canRun)(
    'status shows the deployed harness',
    async () => {
      const statusResult = await spawnAndCollect('agentcore', ['status', '--json'], projectPath);
      expect(statusResult.exitCode, `Status failed: ${statusResult.stderr}`).toBe(0);

      const json = parseJsonOutput(statusResult.stdout) as {
        success: boolean;
        resources: { resourceType: string; name: string; deploymentState: string }[];
      };
      expect(json.success).toBe(true);

      const harness = json.resources.find(r => r.resourceType === 'harness' && r.name === harnessName);
      expect(harness, `Harness "${harnessName}" should appear in status`).toBeDefined();
      expect(harness!.deploymentState).toBe('deployed');
    },
    120000
  );
});
