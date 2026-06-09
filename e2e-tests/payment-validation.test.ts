/**
 * E2E test: Payment validation, config fields, and remove lifecycle
 *
 * Tests payment-specific validation (whitespace creds, StripePrivy key format),
 * config fields (autoPayment, defaultSpendLimit, paymentToolAllowlist, networkPreferences),
 * and remove cascading behavior. No AWS deploy needed — all local.
 */
import { parseJsonOutput, prereqs } from '../src/test-utils/index.js';
import { runAgentCoreCLI } from './e2e-helper.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const canRun = prereqs.npm && prereqs.git && prereqs.uv;

describe.sequential('e2e: payments — validation, config, and remove lifecycle', () => {
  let testDir: string;
  let projectPath: string;

  beforeAll(async () => {
    if (!canRun) return;

    testDir = join(tmpdir(), `agentcore-e2e-payval-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    const createResult = await runAgentCoreCLI(
      [
        'create',
        '--name',
        'PayVal',
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
    expect(createResult.exitCode, `Create failed: stdout=${createResult.stdout} stderr=${createResult.stderr}`).toBe(0);
    const createJson = parseJsonOutput(createResult.stdout) as { projectPath: string };
    projectPath = createJson.projectPath;
  }, 120000);

  afterAll(async () => {
    if (testDir) await rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 1000 });
  });

  // ── Config fields ─────────────────────────────────────────────────────────

  it.skipIf(!canRun)('add payment-manager with --auto-payment and --default-spend-limit', async () => {
    const result = await runAgentCoreCLI(
      [
        'add',
        'payment-manager',
        '--name',
        'cfgMgr',
        '--auto-payment',
        'false',
        '--default-spend-limit',
        '7.50',
        '--json',
      ],
      projectPath
    );
    expect(result.exitCode).toBe(0);

    const config = JSON.parse(await readFile(join(projectPath, 'agentcore', 'agentcore.json'), 'utf-8'));
    const mgr = config.payments.find((p: Record<string, unknown>) => p.name === 'cfgMgr');
    expect(mgr.autoPayment).toBe(false);
    expect(mgr.defaultSpendLimit).toBe('7.50');
  });

  it.skipIf(!canRun)('agentcore.json accepts paymentToolAllowlist and networkPreferences', async () => {
    // validate requires every manager to have at least one connector, so attach one to cfgMgr first.
    const connResult = await runAgentCoreCLI(
      [
        'add',
        'payment-connector',
        '--manager',
        'cfgMgr',
        '--name',
        'cfgConn',
        '--provider',
        'CoinbaseCDP',
        '--api-key-id',
        'key-id',
        '--api-key-secret',
        'key-secret',
        '--wallet-secret',
        'wallet-secret',
        '--json',
      ],
      projectPath
    );
    expect(connResult.exitCode).toBe(0);

    const configPath = join(projectPath, 'agentcore', 'agentcore.json');
    const config = JSON.parse(await readFile(configPath, 'utf-8'));
    const mgr = config.payments.find((p: Record<string, unknown>) => p.name === 'cfgMgr');
    mgr.paymentToolAllowlist = ['http_request', 'fetch_url'];
    mgr.networkPreferences = ['eip155:84532'];
    await writeFile(configPath, JSON.stringify(config, null, 2));

    const valResult = await runAgentCoreCLI(['validate'], projectPath);
    expect(valResult.exitCode, `validate failed: ${valResult.stdout} ${valResult.stderr}`).toBe(0);
  });

  // ── Validation: whitespace credentials ────────────────────────────────────

  it.skipIf(!canRun)('rejects whitespace-only CoinbaseCDP credentials', async () => {
    const result = await runAgentCoreCLI(
      [
        'add',
        'payment-connector',
        '--manager',
        'cfgMgr',
        '--name',
        'wsConn',
        '--provider',
        'CoinbaseCDP',
        '--api-key-id',
        ' ',
        '--api-key-secret',
        '  ',
        '--wallet-secret',
        '   ',
        '--json',
      ],
      projectPath
    );
    expect(result.exitCode).toBe(1);
    const json = parseJsonOutput(result.stdout) as { success: boolean; error: string };
    expect(json.success).toBe(false);
    expect(json.error).toContain('Missing required options');
  });

  // ── Validation: StripePrivy key format ────────────────────────────────────

  it.skipIf(!canRun)('rejects non-base64 StripePrivy authorizationPrivateKey', async () => {
    const result = await runAgentCoreCLI(
      [
        'add',
        'payment-connector',
        '--manager',
        'cfgMgr',
        '--name',
        'badKey',
        '--provider',
        'StripePrivy',
        '--app-id',
        'test',
        '--app-secret',
        'test',
        '--authorization-private-key',
        'not-base64!',
        '--authorization-id',
        'test',
        '--json',
      ],
      projectPath
    );
    expect(result.exitCode).toBe(1);
    const json = parseJsonOutput(result.stdout) as { success: boolean; error: string };
    expect(json.success).toBe(false);
    expect(json.error).toContain('base64');
  });

  it.skipIf(!canRun)('rejects too-short StripePrivy authorizationPrivateKey', async () => {
    const result = await runAgentCoreCLI(
      [
        'add',
        'payment-connector',
        '--manager',
        'cfgMgr',
        '--name',
        'shortKey',
        '--provider',
        'StripePrivy',
        '--app-id',
        'test',
        '--app-secret',
        'test',
        '--authorization-private-key',
        'dGVzdA==',
        '--authorization-id',
        'test',
        '--json',
      ],
      projectPath
    );
    expect(result.exitCode).toBe(1);
    const json = parseJsonOutput(result.stdout) as { success: boolean; error: string };
    expect(json.success).toBe(false);
    expect(json.error).toContain('EC P-256');
  });

  it.skipIf(!canRun)('accepts valid StripePrivy credentials (PKCS#8 P-256 key)', async () => {
    const validKey =
      'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgX172itZu99Ae6bmVpS+6bwKyFmbuy9vkHAIEXwi1IduhRANCAAS160HztG9NZvTv05zfg76koloQ5G+NJwN8lVR5rRKmCLqe+pyc0znwF9Q+LsENdGqi7zTWVVJhhEq3Xa5Tm4F4';
    const result = await runAgentCoreCLI(
      [
        'add',
        'payment-connector',
        '--manager',
        'cfgMgr',
        '--name',
        'spConn',
        '--provider',
        'StripePrivy',
        '--app-id',
        'privy-app',
        '--app-secret',
        'privy-secret',
        '--authorization-private-key',
        validKey,
        '--authorization-id',
        'auth-123',
        '--json',
      ],
      projectPath
    );
    expect(result.exitCode).toBe(0);
    const json = parseJsonOutput(result.stdout) as { success: boolean };
    expect(json.success).toBe(true);
  });

  // ── Validation: duplicate names ───────────────────────────────────────────

  it.skipIf(!canRun)('rejects duplicate manager name', async () => {
    const result = await runAgentCoreCLI(['add', 'payment-manager', '--name', 'cfgMgr', '--json'], projectPath);
    expect(result.exitCode).toBe(1);
    const json = parseJsonOutput(result.stdout) as { success: boolean; error: string };
    expect(json.error).toContain('already exists');
  });

  it.skipIf(!canRun)('rejects connector on non-existent manager', async () => {
    const result = await runAgentCoreCLI(
      [
        'add',
        'payment-connector',
        '--manager',
        'ghostMgr',
        '--name',
        'x',
        '--provider',
        'CoinbaseCDP',
        '--api-key-id',
        'a',
        '--api-key-secret',
        'b',
        '--wallet-secret',
        'c',
        '--json',
      ],
      projectPath
    );
    expect(result.exitCode).toBe(1);
    const json = parseJsonOutput(result.stdout) as { success: boolean; error: string };
    expect(json.error).toContain('not found');
  });

  // ── Remove lifecycle ──────────────────────────────────────────────────────

  it.skipIf(!canRun)('add CDP connector for remove testing', async () => {
    const result = await runAgentCoreCLI(
      [
        'add',
        'payment-connector',
        '--manager',
        'cfgMgr',
        '--name',
        'cdpConn',
        '--provider',
        'CoinbaseCDP',
        '--api-key-id',
        'key-id',
        '--api-key-secret',
        'key-secret',
        '--wallet-secret',
        'wallet-secret',
        '--json',
      ],
      projectPath
    );
    expect(result.exitCode).toBe(0);
  });

  it.skipIf(!canRun)('remove connector cleans env vars', async () => {
    const result = await runAgentCoreCLI(
      ['remove', 'payment-connector', '--manager', 'cfgMgr', '--name', 'cdpConn', '--yes', '--json'],
      projectPath
    );
    expect(result.exitCode).toBe(0);

    const envContent = await readFile(join(projectPath, 'agentcore', '.env.local'), 'utf-8');
    expect(envContent).not.toContain('CDPCONN_CDP_API_KEY_ID');
  });

  it.skipIf(!canRun)('remove manager cascades (removes remaining connectors + env vars)', async () => {
    const result = await runAgentCoreCLI(
      ['remove', 'payment-manager', '--name', 'cfgMgr', '--yes', '--json'],
      projectPath
    );
    expect(result.exitCode).toBe(0);

    const config = JSON.parse(await readFile(join(projectPath, 'agentcore', 'agentcore.json'), 'utf-8'));
    expect(config.payments).toEqual([]);

    const envContent = await readFile(join(projectPath, 'agentcore', '.env.local'), 'utf-8');
    expect(envContent.trim()).toBe('');
  });
});
