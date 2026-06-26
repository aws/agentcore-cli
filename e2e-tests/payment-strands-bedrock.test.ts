/**
 * E2E test: Payment manager + connector → deploy → status
 *
 * Creates a Strands/Bedrock project with a payment manager and connector,
 * deploys it to AWS, and verifies payment infrastructure is created correctly.
 *
 * Required env vars:
 *   - AWS credentials (via profile or env vars)
 *   - CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET (for connector creation)
 *   - CDK_TARBALL (optional — path to payment-aware CDK constructs tgz)
 */
import { hasAwsCredentials, parseJsonOutput, prereqs, retry } from '../src/test-utils/index.js';
import { installCdkTarball, runAgentCoreCLI, teardownE2EProject, writeAwsTargets } from './e2e-helper.js';
import { type Logger, getLogger } from './utils/logger.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const hasAws: boolean = hasAwsCredentials();
const hasCdpCreds = !!(process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET && process.env.CDP_WALLET_SECRET);
const canRun = prereqs.npm && prereqs.git && prereqs.uv && hasAws && hasCdpCreds;

describe.sequential('e2e: payments — create → add payment → deploy → status', () => {
  let testDir: string;
  let projectPath: string;
  let agentName: string;
  let logger: Logger;
  const managerName = 'E2ePayMgr';
  const connectorName = 'E2ePayConn';

  beforeAll(async () => {
    logger = getLogger('payments-strands-bedrock');
    if (!canRun) {
      logger.warn(`tests are skipped due to insufficient conditions. hasCdpCreds=${hasCdpCreds}, hasAws=${hasAws}`);
      return;
    }
    testDir = join(tmpdir(), `agentcore-e2e-pay-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    agentName = `E2ePay${String(Date.now()).slice(-8)}`;

    // Create project
    const createResult = await runAgentCoreCLI(
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

    expect(createResult.exitCode, `Create failed: ${createResult.stderr}`).toBe(0);
    const createJson = parseJsonOutput(createResult.stdout) as { projectPath: string };
    projectPath = createJson.projectPath;

    // Add payment manager
    const mgrResult = await runAgentCoreCLI(['add', 'payment-manager', '--name', managerName, '--json'], projectPath);
    expect(mgrResult.exitCode, `Add manager failed: ${mgrResult.stderr}`).toBe(0);

    // Add payment connector with CDP credentials
    const connResult = await runAgentCoreCLI(
      [
        'add',
        'payment-connector',
        '--manager',
        managerName,
        '--name',
        connectorName,
        '--provider',
        'CoinbaseCDP',
        '--api-key-id',
        process.env.CDP_API_KEY_ID!,
        '--api-key-secret',
        process.env.CDP_API_KEY_SECRET!,
        '--wallet-secret',
        process.env.CDP_WALLET_SECRET!,
        '--json',
      ],
      projectPath
    );
    expect(connResult.exitCode, `Add connector failed: ${connResult.stderr}`).toBe(0);

    // Write AWS targets + install CDK tarball
    await writeAwsTargets(projectPath);
    installCdkTarball(projectPath);
  }, 300000);

  afterAll(async () => {
    if (projectPath && hasAws) {
      await teardownE2EProject(projectPath, agentName, 'Bedrock');
    }
    if (testDir) await rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 1000 });
  }, 600000);

  it.skipIf(!canRun)('has correct agentcore.json structure', async () => {
    const configPath = join(projectPath, 'agentcore', 'agentcore.json');
    const config = JSON.parse(await readFile(configPath, 'utf-8'));

    // Manager exists with correct fields
    const manager = config.payments?.find((p: Record<string, unknown>) => p.name === managerName);
    expect(manager).toBeTruthy();
    expect(manager.authorizerType).toBe('AWS_IAM');
    expect(manager.autoPayment).toBe(true);

    // Connector nested inside manager
    const connector = manager.connectors?.find((c: Record<string, unknown>) => c.name === connectorName);
    expect(connector).toBeTruthy();
    expect(connector.provider).toBe('CoinbaseCDP');

    // Credential exists
    const cred = config.credentials?.find(
      (c: Record<string, unknown>) => c.authorizerType === 'PaymentCredentialProvider'
    );
    expect(cred).toBeTruthy();
  });

  it.skipIf(!canRun)('stores connector secrets encrypted at rest, never as plaintext', async () => {
    // The deploy step below reads these same values back and decrypts them, so a
    // passing deploy already proves the round trip works. This assertion additionally
    // pins the security invariant the encryption feature exists to guarantee: the raw
    // secret must never touch disk in cleartext. Without it, a regression that silently
    // reverted to plaintext storage would still deploy green and go unnoticed.
    const envLocal = await readFile(join(projectPath, 'agentcore', '.env.local'), 'utf-8');

    expect(envLocal, '.env.local should contain at least one enc:v1: envelope').toContain('enc:v1:');

    for (const raw of [process.env.CDP_API_KEY_SECRET!, process.env.CDP_WALLET_SECRET!]) {
      expect(envLocal, 'raw secret value must not appear in cleartext on disk').not.toContain(raw);
    }
  });

  it.skipIf(!canRun)('has payment capability code in agent', async () => {
    const config = JSON.parse(await readFile(join(projectPath, 'agentcore', 'agentcore.json'), 'utf-8'));
    const runtimeName = config.runtimes?.[0]?.name;
    expect(runtimeName).toBeTruthy();

    // payments.py exists with per-invocation factory
    const paymentsCode = await readFile(
      join(projectPath, 'app', runtimeName, 'capabilities', 'payments', 'payments.py'),
      'utf-8'
    );
    expect(paymentsCode).toContain('create_payments_plugin');
    expect(paymentsCode).toContain('user_id');
    expect(paymentsCode).toContain('instrument_id');
    expect(paymentsCode).toContain('session_id');
  });

  it.skipIf(!canRun)(
    'deploys to AWS successfully',
    async () => {
      expect(projectPath).toBeTruthy();

      await retry(
        async () => {
          const result = await runAgentCoreCLI(['deploy', '--yes', '--json'], projectPath);

          if (result.exitCode !== 0) {
            logger.error(`deploy stdout=${result.stdout}`);
            logger.error(`deploy stderr=${result.stderr}`);
          }

          expect(result.exitCode, `Deploy failed: ${result.stderr}`).toBe(0);

          const json = parseJsonOutput(result.stdout) as { success: boolean };
          expect(json.success).toBe(true);
        },
        1,
        30000
      );
    },
    600000
  );

  it.skipIf(!canRun)('status shows payment manager', async () => {
    expect(projectPath).toBeTruthy();

    const result = await runAgentCoreCLI(['status', '--json'], projectPath);
    expect(result.exitCode).toBe(0);

    const json = parseJsonOutput(result.stdout) as {
      success: boolean;
      resources: { resourceType: string; name: string; deploymentState: string }[];
    };
    expect(json.success).toBe(true);

    // Find payment resource
    const paymentResource = json.resources?.find(r => r.resourceType === 'payment' && r.name === managerName);
    expect(paymentResource, 'Payment manager should appear in status').toBeTruthy();
    expect(paymentResource!.deploymentState).toBe('deployed');
  });

  it.skipIf(!canRun)('deployed-state.json has payment manager and connector info', async () => {
    // Read deployed state from the CLI's internal state
    const statePath = join(projectPath, 'agentcore', '.cli', 'deployed-state.json');
    const state = JSON.parse(await readFile(statePath, 'utf-8'));

    const targetState = Object.values(state.targets)[0] as Record<string, unknown>;
    const resources = targetState?.resources as Record<string, unknown>;
    const payments = resources?.payments as Record<string, unknown>;

    expect(payments).toBeTruthy();
    const managerState = payments[managerName] as Record<string, unknown>;
    expect(managerState).toBeTruthy();
    expect(managerState.managerId).toBeTruthy();
    expect(managerState.managerArn).toBeTruthy();
    expect(managerState.processPaymentRoleArn).toBeTruthy();
    expect(managerState.resourceRetrievalRoleArn).toBeTruthy();

    // Connector info
    const connectors = managerState.connectors as Record<string, Record<string, unknown>>;
    expect(connectors).toBeTruthy();
    const connState = connectors[connectorName];
    expect(connState).toBeTruthy();
    expect(connState!.connectorId).toBeTruthy();
    expect(connState!.credentialProviderArn).toBeTruthy();
  });
});
