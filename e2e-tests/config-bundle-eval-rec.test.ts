/**
 * E2E tests for Config Bundles, Batch Evaluation, and Recommendations.
 *
 * Flow: create project → add config bundle → add evaluator → deploy →
 *       invoke → test config-bundle CLI → run batch-evaluation → run recommendation
 *
 * Prerequisites:
 *   - AWS credentials
 *   - npm, git, uv installed
 */
import { parseJsonOutput, retry } from '../src/test-utils/index.js';
import {
  baseCanRun,
  hasAws,
  installCdkTarball,
  runAgentCoreCLI,
  teardownE2EProject,
  writeAwsTargets,
} from './e2e-helper.js';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const canRun = baseCanRun && hasAws;

describe.sequential('e2e: config bundles, batch evaluation, and recommendations', () => {
  let testDir: string;
  let projectPath: string;
  const agentName = `E2eCbEr${String(Date.now()).slice(-8)}`;
  const bundleName = 'E2eTestBundle';
  const evalName = 'E2eCustomEval';

  beforeAll(async () => {
    if (!canRun) return;

    testDir = join(tmpdir(), `agentcore-e2e-cb-eval-rec-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    // Create project with agent
    const result = await runAgentCoreCLI(
      [
        'create',
        '--name',
        agentName,
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
      testDir
    );
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
  // Config Bundle — add to project
  // ════════════════════════════════════════════════════════════════════════

  it.skipIf(!canRun)(
    'adds a config bundle to the project',
    async () => {
      const components = JSON.stringify({
        [`{{runtime:${agentName}}}`]: {
          configuration: {
            systemPrompt: 'You are a helpful e2e test assistant.',
            temperature: 0.7,
          },
        },
      });

      const result = await run([
        'add',
        'config-bundle',
        '--name',
        bundleName,
        '--description',
        'E2E test config bundle',
        '--components',
        components,
        '--branch',
        'mainline',
        '--commit-message',
        'Initial e2e bundle',
        '--json',
      ]);

      expect(result.exitCode, `Add config-bundle failed: ${result.stdout}`).toBe(0);
      const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
      expect(json.success).toBe(true);
      expect(json.bundleName).toBe(bundleName);
    },
    60000
  );

  // ════════════════════════════════════════════════════════════════════════
  // Evaluator — add to project
  // ════════════════════════════════════════════════════════════════════════

  it.skipIf(!canRun)(
    'adds a custom evaluator to the project',
    async () => {
      const result = await run([
        'add',
        'evaluator',
        '--name',
        evalName,
        '--level',
        'SESSION',
        '--model',
        'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
        '--instructions',
        'Evaluate the overall quality of this session. Context: {context}',
        '--json',
      ]);

      expect(result.exitCode, `Add evaluator failed: ${result.stdout}`).toBe(0);
      const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
      expect(json.success).toBe(true);
      expect(json.evaluatorName).toBe(evalName);
    },
    60000
  );

  // ════════════════════════════════════════════════════════════════════════
  // Deploy
  // ════════════════════════════════════════════════════════════════════════

  it.skipIf(!canRun)(
    'deploys the project with config bundle and evaluator',
    async () => {
      const result = await run(['deploy', '--yes', '--json']);

      if (result.exitCode !== 0) {
        console.log('Deploy stdout:', result.stdout);
        console.log('Deploy stderr:', result.stderr);
      }

      expect(result.exitCode, 'Deploy failed').toBe(0);
      const json = parseJsonOutput(result.stdout) as { success: boolean };
      expect(json.success).toBe(true);
    },
    600000
  );

  // ════════════════════════════════════════════════════════════════════════
  // Invoke — generate traces for evaluation
  // ════════════════════════════════════════════════════════════════════════

  it.skipIf(!canRun)(
    'invokes the deployed agent to generate traces',
    async () => {
      await retry(
        async () => {
          const result = await run([
            'invoke',
            '--prompt',
            'What is 3 + 5? Use the add_numbers tool.',
            '--runtime',
            agentName,
            '--json',
          ]);
          expect(result.exitCode, `Invoke failed: ${result.stderr}`).toBe(0);
          const json = parseJsonOutput(result.stdout) as { success: boolean };
          expect(json.success).toBe(true);
        },
        3,
        15000
      );
    },
    180000
  );

  // ════════════════════════════════════════════════════════════════════════
  // Status — verify config bundle and evaluator deployed
  // ════════════════════════════════════════════════════════════════════════

  it.skipIf(!canRun)(
    'status shows deployed config bundle and evaluator',
    async () => {
      const result = await run(['status', '--json']);

      expect(result.exitCode, `Status failed: ${result.stderr}`).toBe(0);
      const json = parseJsonOutput(result.stdout) as {
        success: boolean;
        resources: { resourceType: string; name: string; deploymentState: string }[];
      };
      expect(json.success).toBe(true);

      const bundle = json.resources.find(r => r.resourceType === 'config-bundle' && r.name === bundleName);
      expect(bundle, `Config bundle "${bundleName}" should appear in status`).toBeDefined();

      const evaluator = json.resources.find(r => r.resourceType === 'evaluator' && r.name === evalName);
      expect(evaluator, `Evaluator "${evalName}" should appear in status`).toBeDefined();
    },
    120000
  );

  // ════════════════════════════════════════════════════════════════════════
  // Config Bundle — versions and diff via CLI
  // ════════════════════════════════════════════════════════════════════════

  let initialVersionId: string;

  it.skipIf(!canRun)(
    'config-bundle versions lists the deployed version',
    async () => {
      const result = await run(['config-bundle', 'versions', '--bundle', bundleName, '--json']);

      expect(result.exitCode, `cb versions failed: ${result.stderr}`).toBe(0);
      const json = parseJsonOutput(result.stdout) as {
        versions: { versionId: string; lineageMetadata?: { branchName?: string; commitMessage?: string } }[];
        bundleName: string;
      };

      expect(json.bundleName).toBe(bundleName);
      expect(json.versions.length).toBeGreaterThanOrEqual(1);
      initialVersionId = json.versions[0]!.versionId;
      expect(initialVersionId).toBeTruthy();
    },
    120000
  );

  it.skipIf(!canRun)(
    'config-bundle versions supports --branch filter',
    async () => {
      const result = await run(['config-bundle', 'versions', '--bundle', bundleName, '--branch', 'mainline', '--json']);

      expect(result.exitCode, `cb versions --branch failed: ${result.stderr}`).toBe(0);
      const json = parseJsonOutput(result.stdout) as {
        versions: { versionId: string; lineageMetadata?: { branchName?: string } }[];
      };

      for (const v of json.versions) {
        expect(v.lineageMetadata?.branchName).toBe('mainline');
      }
    },
    120000
  );

  it.skipIf(!canRun)(
    'updates config bundle by redeploying with changed components',
    async () => {
      // Update the config bundle in agentcore.json with new component values
      const components = JSON.stringify({
        [`{{runtime:${agentName}}}`]: {
          configuration: {
            systemPrompt: 'You are an UPDATED e2e test assistant.',
            temperature: 0.9,
            maxTokens: 2048,
          },
        },
      });

      // Remove old bundle, add new one with same name but different components
      let result = await run(['remove', 'config-bundle', '--name', bundleName, '--json']);
      expect(result.exitCode, `Remove config-bundle failed: ${result.stdout}`).toBe(0);

      result = await run([
        'add',
        'config-bundle',
        '--name',
        bundleName,
        '--description',
        'E2E test config bundle - updated',
        '--components',
        components,
        '--branch',
        'mainline',
        '--commit-message',
        'Update system prompt and add maxTokens',
        '--json',
      ]);
      expect(result.exitCode, `Re-add config-bundle failed: ${result.stdout}`).toBe(0);

      // Redeploy to push the updated bundle
      result = await run(['deploy', '--yes', '--json']);
      expect(result.exitCode, `Redeploy failed: ${result.stdout}`).toBe(0);
    },
    600000
  );

  it.skipIf(!canRun)(
    'config-bundle versions shows both versions after update',
    async () => {
      const result = await run(['config-bundle', 'versions', '--bundle', bundleName, '--json']);

      expect(result.exitCode, `cb versions failed: ${result.stderr}`).toBe(0);
      const json = parseJsonOutput(result.stdout) as {
        versions: { versionId: string }[];
      };

      expect(json.versions.length).toBeGreaterThanOrEqual(2);
    },
    120000
  );

  it.skipIf(!canRun)(
    'config-bundle diff shows changes between versions',
    async () => {
      // Get the latest two versions
      const versionsResult = await run(['config-bundle', 'versions', '--bundle', bundleName, '--json']);
      const versionsJson = parseJsonOutput(versionsResult.stdout) as {
        versions: { versionId: string }[];
      };

      expect(versionsJson.versions.length).toBeGreaterThanOrEqual(2);
      const newestVersion = versionsJson.versions[0]!.versionId;
      const oldestVersion = versionsJson.versions[versionsJson.versions.length - 1]!.versionId;

      const result = await run([
        'config-bundle',
        'diff',
        '--bundle',
        bundleName,
        '--from',
        oldestVersion,
        '--to',
        newestVersion,
        '--json',
      ]);

      expect(result.exitCode, `cb diff failed: ${result.stderr}`).toBe(0);
      const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
      expect(json).toHaveProperty('fromVersion');
      expect(json).toHaveProperty('toVersion');
      expect(json.diffs).toBeInstanceOf(Array);
      expect((json.diffs as unknown[]).length).toBeGreaterThan(0);
    },
    120000
  );

  // ════════════════════════════════════════════════════════════════════════
  // Batch Evaluation — run through CLI
  // ════════════════════════════════════════════════════════════════════════

  it.skipIf(!canRun)(
    'runs batch evaluation with Builtin evaluator via CLI',
    async () => {
      await retry(
        async () => {
          const result = await run([
            'run',
            'batch-evaluation',
            '--runtime',
            agentName,
            '--evaluator',
            'Builtin.Faithfulness',
            '--lookback-days',
            '1',
            '--json',
          ]);

          expect(result.exitCode, `batch-evaluation failed (stdout: ${result.stdout}, stderr: ${result.stderr})`).toBe(
            0
          );
          const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
          expect(json).toHaveProperty('success', true);
          expect(json).toHaveProperty('batchEvaluationId');
          expect(json.status).toBeDefined();
          expect(json.status).not.toBe('FAILED');
        },
        6,
        15000
      );
    },
    600000
  );

  it.skipIf(!canRun)(
    'runs batch evaluation with ground truth file',
    async () => {
      // Invoke to get a real session ID for ground truth
      const invokeResult = await run(['invoke', '--prompt', 'What is 2+2?', '--runtime', agentName, '--json']);
      expect(invokeResult.exitCode).toBe(0);
      const invokeJson = parseJsonOutput(invokeResult.stdout) as { sessionId: string };
      expect(invokeJson.sessionId).toBeTruthy();

      // Create ground truth file using the real session ID
      const gtData = [
        {
          sessionId: invokeJson.sessionId,
          groundTruth: {
            inline: {
              assertions: [{ text: 'Agent should provide a numerical answer' }],
            },
          },
        },
      ];
      const gtPath = join(projectPath, 'ground-truth.json');
      await writeFile(gtPath, JSON.stringify(gtData));

      await retry(
        async () => {
          const result = await run([
            'run',
            'batch-evaluation',
            '--runtime',
            agentName,
            '--evaluator',
            'Builtin.Correctness',
            '--ground-truth',
            gtPath,
            '--lookback-days',
            '1',
            '--json',
          ]);

          expect(result.exitCode, `batch-evaluation with GT failed: ${result.stdout}`).toBe(0);
          const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
          expect(json).toHaveProperty('success', true);
        },
        6,
        15000
      );
    },
    600000
  );

  // ════════════════════════════════════════════════════════════════════════
  // On-demand Eval — run eval via CLI (existing pattern)
  // ════════════════════════════════════════════════════════════════════════

  it.skipIf(!canRun)(
    'runs on-demand eval with Builtin evaluator via CLI',
    async () => {
      // Retries needed: traces from invoke take time to propagate to CloudWatch
      await retry(
        async () => {
          const result = await run([
            'run',
            'eval',
            '--runtime',
            agentName,
            '--evaluator',
            'Builtin.Faithfulness',
            '--days',
            '1',
            '--json',
          ]);

          expect(result.exitCode, `run eval failed (stdout: ${result.stdout}, stderr: ${result.stderr})`).toBe(0);
          const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
          expect(json).toHaveProperty('success', true);
          expect(json).toHaveProperty('run');
          expect(json).toHaveProperty('filePath');
        },
        10,
        15000
      );
    },
    300000
  );

  // ════════════════════════════════════════════════════════════════════════
  // Recommendation — run through CLI
  // ════════════════════════════════════════════════════════════════════════

  it.skipIf(!canRun)(
    'runs system prompt recommendation with inline content via CLI',
    async () => {
      await retry(
        async () => {
          const result = await run([
            'run',
            'recommendation',
            '--runtime',
            agentName,
            '--evaluator',
            'Builtin.Faithfulness',
            '--inline',
            'You are a helpful assistant for testing.',
            '--lookback',
            '1',
            '--json',
          ]);

          expect(result.exitCode, `recommendation failed (stdout: ${result.stdout}, stderr: ${result.stderr})`).toBe(0);
          const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
          expect(json).toHaveProperty('success', true);
          expect(json).toHaveProperty('recommendationId');
          expect(json.result).toBeDefined();
          expect(json.result).not.toBe('');
          expect(json.result).not.toBeNull();
        },
        6,
        30000
      );
    },
    600000
  );

  it.skipIf(!canRun)(
    'runs system prompt recommendation with prompt file via CLI',
    async () => {
      const promptFile = join(projectPath, 'system-prompt.txt');
      await writeFile(promptFile, 'You are a helpful customer support assistant. Answer politely.');

      await retry(
        async () => {
          const result = await run([
            'run',
            'recommendation',
            '--runtime',
            agentName,
            '--evaluator',
            'Builtin.Helpfulness',
            '--prompt-file',
            promptFile,
            '--lookback',
            '1',
            '--json',
          ]);

          expect(result.exitCode, `recommendation from file failed: ${result.stdout}`).toBe(0);
          const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
          expect(json).toHaveProperty('success', true);
          expect(json).toHaveProperty('recommendationId');
        },
        6,
        30000
      );
    },
    600000
  );

  it.skipIf(!canRun)(
    'runs tool description recommendation via CLI',
    async () => {
      await retry(
        async () => {
          const result = await run([
            'run',
            'recommendation',
            '--type',
            'tool-description',
            '--runtime',
            agentName,
            '--tools',
            'add_numbers:Adds two numbers together',
            '--lookback',
            '1',
            '--json',
          ]);

          expect(result.exitCode, `tool-desc recommendation failed: ${result.stdout}`).toBe(0);
          const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
          expect(json).toHaveProperty('success', true);
          expect(json).toHaveProperty('recommendationId');
        },
        6,
        30000
      );
    },
    600000
  );

  it.skipIf(!canRun)(
    'runs recommendation with config bundle source via CLI',
    async () => {
      // Get the latest version ID for the bundle
      const versionsResult = await run(['config-bundle', 'versions', '--bundle', bundleName, '--json']);
      const versionsJson = parseJsonOutput(versionsResult.stdout) as {
        versions: { versionId: string }[];
      };
      const latestVersion = versionsJson.versions[0]!.versionId;

      await retry(
        async () => {
          const result = await run([
            'run',
            'recommendation',
            '--runtime',
            agentName,
            '--evaluator',
            'Builtin.Faithfulness',
            '--bundle-name',
            bundleName,
            '--bundle-version',
            latestVersion,
            '--system-prompt-json-path',
            'systemPrompt',
            '--lookback',
            '1',
            '--json',
          ]);

          expect(result.exitCode, `bundle recommendation failed: ${result.stdout}`).toBe(0);
          const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
          expect(json).toHaveProperty('success', true);
          expect(json).toHaveProperty('recommendationId');
        },
        6,
        30000
      );
    },
    600000
  );

  // ════════════════════════════════════════════════════════════════════════
  // Cleanup — remove config bundle from project
  // ════════════════════════════════════════════════════════════════════════

  it.skipIf(!canRun)(
    'removes config bundle from project and redeploys (reconciliation deletes it)',
    async () => {
      let result = await run(['remove', 'config-bundle', '--name', bundleName, '--json']);
      expect(result.exitCode, `Remove config-bundle failed: ${result.stdout}`).toBe(0);

      const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
      expect(json.success).toBe(true);

      // Redeploy triggers reconciliation (orphaned bundle deleted server-side)
      result = await run(['deploy', '--yes', '--json']);
      expect(result.exitCode, `Final deploy failed: ${result.stdout}`).toBe(0);
    },
    600000
  );
});
