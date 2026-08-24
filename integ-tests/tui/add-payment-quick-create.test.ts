import { TuiSession, WaitForTimeoutError } from '../../src/tui-harness/index.js';
import { createMinimalProjectDir } from './helpers.js';
import type { MinimalProjectDirResult } from './helpers.js';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_DIST = join(__dirname, '..', '..', 'dist', 'cli', 'index.mjs');

function screenText(session: TuiSession): string {
  return session.readScreen().lines.join('\n');
}

async function waitFor(session: TuiSession, pattern: string | RegExp, timeoutMs = 10_000): Promise<boolean> {
  try {
    await session.waitFor(pattern, timeoutMs);
    return true;
  } catch (error) {
    if (error instanceof WaitForTimeoutError) return false;
    throw error;
  }
}

describe('Add Payment Connector Quick Create Flow', () => {
  let session: TuiSession;
  let project: MinimalProjectDirResult;
  let configPath: string;

  beforeAll(async () => {
    project = await createMinimalProjectDir({ projectName: 'QuickCreateTui' });
    configPath = join(project.dir, 'agentcore', 'agentcore.json');
    const config = JSON.parse(await readFile(configPath, 'utf-8'));
    config.payments = [
      {
        name: 'TuiManager',
        authorizerType: 'AWS_IAM',
        connectors: [],
        autoPayment: true,
        defaultSpendLimit: '10.00',
      },
    ];
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');

    session = await TuiSession.launch({
      command: process.execPath,
      args: [CLI_DIST, 'add', 'payment-connector'],
      cwd: project.dir,
      cols: 120,
      rows: 35,
    });
  });

  afterAll(async () => {
    if (session?.alive) await session.close();
    if (project) await project.cleanup();
  });

  it('auto-selects the only manager and lists Quick Create first', async () => {
    const found = await waitFor(session, 'Choose connector setup', 15_000);
    expect(found, screenText(session)).toBe(true);
    const text = screenText(session);
    expect(text).toContain('Quick Create with Coinbase');
    expect(text.indexOf('Quick Create with Coinbase')).toBeLessThan(text.indexOf('Coinbase CDP credentials'));
    expect(text.indexOf('Coinbase CDP credentials')).toBeLessThan(text.indexOf('Stripe + Privy credentials'));
    expect(text).not.toContain('Select payment manager');
  });

  it('skips credential entry and collects the connector name', async () => {
    await session.sendSpecialKey('enter');
    expect(await waitFor(session, 'Connector name')).toBe(true);
    const text = screenText(session);
    expect(text).not.toContain('API Key ID');
    expect(text).not.toContain('Wallet Secret');
    expect(text).not.toContain('Privy App ID');
  });

  it('shows a secret-free Quick Create confirmation', async () => {
    await session.sendSpecialKey('enter');
    expect(await waitFor(session, 'Review Configuration')).toBe(true);
    const text = screenText(session);
    expect(text).toContain('Manager: TuiManager');
    expect(text).toContain('Provisioning: Quick Create');
    expect(text).toContain('Provider: Coinbase CDP');
    expect(text).not.toContain('API Key');
    expect(text).not.toContain('Wallet Secret');
    expect(text).not.toContain('App Secret');
  });

  it('persists the Quick Create shape and explains the deploy handoff', async () => {
    await session.sendSpecialKey('enter');
    expect(await waitFor(session, 'receive its authorization URL')).toBe(true);

    const config = JSON.parse(await readFile(configPath, 'utf-8'));
    expect(config.credentials).toEqual([]);
    expect(config.payments[0].connectors).toEqual([
      {
        name: 'MyCdpConnector',
        provider: 'CoinbaseCDP',
        provisionMode: 'QUICK_CREATE',
      },
    ]);
  });
});
