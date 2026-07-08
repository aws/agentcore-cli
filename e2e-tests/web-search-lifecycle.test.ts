import { type RunResult, hasAwsCredentials, parseJsonOutput, prereqs } from '../src/test-utils/index.js';
import { installCdkTarball, runAgentCoreCLI, teardownE2EProject, writeAwsTargets } from './e2e-helper.js';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const hasAws = hasAwsCredentials();
const canRun = prereqs.npm && prereqs.git && prereqs.uv && hasAws;

describe.sequential('e2e: web-search gateway target lifecycle', () => {
  const suffix = Date.now().toString().slice(-8);
  const agentName = `E2eWs${suffix}`;
  const gatewayName = 'WsGw';
  const targetName = 'ws1';
  const toolName = `${targetName}___WebSearch`;

  let testDir: string;
  let projectPath: string;
  let originalRegion: string | undefined;
  let lifecycleFailed = false;

  beforeAll(async () => {
    if (!canRun) return;

    originalRegion = process.env.AWS_REGION;
    process.env.AWS_REGION = 'us-east-1';

    testDir = join(tmpdir(), `agentcore-e2e-web-search-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    const create = await runAgentCoreCLI(
      ['create', '--name', agentName, '--no-agent', '--defaults', '--skip-git', '--skip-python-setup', '--json'],
      testDir
    );
    expect(create.exitCode, `Create failed: ${create.stderr}`).toBe(0);
    projectPath = (parseJsonOutput(create.stdout) as { projectPath: string }).projectPath;

    await writeAwsTargets(projectPath);
    installCdkTarball(projectPath);
  }, 600_000);

  afterAll(async () => {
    if (projectPath && hasAws) {
      await teardownE2EProject(projectPath, agentName, 'Bedrock');
    }
    if (testDir) await rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 1000 });
    if (originalRegion === undefined) delete process.env.AWS_REGION;
    else process.env.AWS_REGION = originalRegion;
  }, 600_000);

  const run = (args: string[]): Promise<RunResult> => runAgentCoreCLI(args, projectPath);

  const step = (label: string, fn: () => Promise<void>, timeout: number) =>
    it.skipIf(!canRun)(
      label,
      async () => {
        if (lifecycleFailed) {
          throw new Error('Skipped: a prior step in the lifecycle failed.');
        }
        try {
          await fn();
        } catch (err) {
          lifecycleFailed = true;
          throw err;
        }
      },
      timeout
    );

  step(
    'adds a gateway and a web-search connector target',
    async () => {
      const gw = await run(['add', 'gateway', '--name', gatewayName, '--protocol-type', 'MCP', '--json']);
      expect(gw.exitCode, `Add gateway failed: ${gw.stderr}`).toBe(0);

      const target = await run([
        'add',
        'gateway-target',
        '--type',
        'connector',
        '--connector',
        'web-search',
        '--gateway',
        gatewayName,
        '--name',
        targetName,
        '--json',
      ]);
      expect(target.exitCode, `Add web-search failed: ${target.stdout}\n${target.stderr}`).toBe(0);
    },
    120_000
  );

  step(
    'deploys the stack',
    async () => {
      const result = await run(['deploy', '--yes', '--json']);
      expect(result.exitCode, `Deploy failed: ${result.stderr}`).toBe(0);
    },
    900_000
  );

  step(
    'status shows the gateway as deployed',
    async () => {
      const result = await run(['status', '--json']);
      expect(result.exitCode, `Status failed: ${result.stderr}`).toBe(0);

      const json = parseJsonOutput(result.stdout) as {
        success: boolean;
        resources: { resourceType: string; name: string; deploymentState: string }[];
      };
      expect(json.success).toBe(true);

      const gateway = json.resources.find(r => r.resourceType === 'gateway' && r.name === gatewayName);
      expect(gateway, 'Gateway should appear in status').toBeDefined();
      expect(gateway?.deploymentState).toBe('deployed');
    },
    120_000
  );

  step(
    'call-tool returns search results',
    async () => {
      const result = await run([
        'invoke',
        'call-tool',
        '--gateway',
        gatewayName,
        '--tool',
        toolName,
        '--input',
        '{"query":"AWS Lambda pricing"}',
        '--json',
      ]);
      expect(result.exitCode, `call-tool failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);

      const payload = parseJsonOutput(result.stdout) as { success: boolean; response?: string };
      expect(payload.success, `call-tool result not successful. Raw stdout:\n${result.stdout}`).toBe(true);
      expect(typeof payload.response, 'response should be a JSON envelope string').toBe('string');

      const envelope = JSON.parse(payload.response!) as {
        result?: { content?: { text?: string }[] };
      };
      const text = envelope.result?.content?.[0]?.text;
      expect(text, `call-tool envelope missing result.content[0].text. Envelope:\n${payload.response}`).toBeTruthy();

      const inner = JSON.parse(text!) as { results?: { url?: string }[] };
      expect(Array.isArray(inner.results), 'Results array should be present').toBe(true);
      expect(inner.results!.length, 'Results array should be non-empty').toBeGreaterThan(0);
    },
    180_000
  );
});
