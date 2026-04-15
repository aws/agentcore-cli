/**
 * TUI test: Verify that pressing Escape on the "Attach to gateways" screen
 * during policy engine creation goes back to the name step without writing
 * anything to agentcore.json.
 *
 * Three scenarios:
 * 1. Escape goes back (main bug fix) — no engine written
 * 2. Enter with no selection — engine written, no gateway attachment
 * 3. Full flow (select gateway + mode) — engine + attachment written
 */
import { TuiSession, closeAll } from '../index.js';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

// Built CLI entry point (absolute path)
const CLI_ENTRY = join(__dirname, '..', '..', '..', 'dist', 'cli', 'index.mjs');

// Base config: project with one unprotected gateway, no policy engines.
function baseConfig() {
  return {
    name: 'PolicyTestProject',
    version: 1,
    managedBy: 'CDK',
    runtimes: [],
    memories: [],
    credentials: [],
    evaluators: [],
    onlineEvalConfigs: [],
    agentCoreGateways: [
      {
        name: 'TestGateway',
        targets: [],
        authorizerType: 'NONE',
        enableSemanticSearch: true,
        exceptionLevel: 'NONE',
      },
    ],
    policyEngines: [],
  };
}

describe('AddPolicyFlow — Escape on attach-gateways', () => {
  let projectDir: string;
  let configPath: string;
  let session: TuiSession | null = null;

  beforeEach(async () => {
    // Create a fresh temp project for each test
    projectDir = join(tmpdir(), `policy-escape-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(projectDir, 'agentcore'), { recursive: true });
    configPath = join(projectDir, 'agentcore', 'agentcore.json');
    await writeFile(configPath, JSON.stringify(baseConfig(), null, 2) + '\n', 'utf-8');
  });

  afterEach(async () => {
    if (session) {
      try {
        await session.close();
      } catch {
        // already closed
      }
      session = null;
    }
    // Clean up temp directory
    await rm(projectDir, { recursive: true, force: true }).catch(() => {
      /* ignore cleanup errors */
    });
  });

  afterAll(async () => {
    await closeAll();
  });

  /**
   * Helper: launch CLI and navigate to the Policy Engine creation flow.
   * Returns the session positioned at the engine name input step.
   */
  async function launchAndNavigateToEngineCreation(): Promise<TuiSession> {
    session = await TuiSession.launch({
      command: 'node',
      args: [CLI_ENTRY],
      cwd: projectDir,
      cols: 120,
      rows: 40,
    });

    // Wait for HelpScreen
    await session.waitFor('Commands', 15000);

    // Filter to "add" and press Enter
    await session.sendKeys('add', 500);
    await session.sendSpecialKey('enter', 1000);

    // Wait for Add Resource screen
    await session.waitFor('Add Resource', 10000);

    // Navigate down to "Policy" — the last item in the Add Resource list.
    // List order: Agent(0), Memory(1), Credential(2), Evaluator(3),
    //             Online Eval Config(4), Gateway(5), Gateway Target(6), Policy(7)
    // Press down 7 times to reach "Policy" from the top.
    for (let i = 0; i < 7; i++) {
      await session.sendSpecialKey('down', 200);
    }

    // Verify cursor is on "Policy" before pressing Enter.
    // The TUI uses U+276F (❯) as the cursor indicator, not ASCII ">".
    const screen = session.readScreen();
    const lines = screen.lines;
    const cursorOnPolicy = lines.some(l => l.includes('\u276F') && l.includes('Policy'));
    if (!cursorOnPolicy) {
      throw new Error('Cursor not on Policy item. Screen:\n' + lines.filter(l => l.trim().length > 0).join('\n'));
    }

    await session.sendSpecialKey('enter', 1500);

    // Since our test config has no policy engines, the AddPolicyFlow goes
    // directly to the engine-wizard (name input step). No "select engine"
    // screen appears.
    return session;
  }

  async function readConfigFromDisk(): Promise<Record<string, unknown>> {
    const raw = await readFile(configPath, 'utf-8');
    return JSON.parse(raw);
  }

  // -----------------------------------------------------------------------
  // Scenario 1: Escape on the gateway screen goes back to name step
  // -----------------------------------------------------------------------
  it('Escape on attach-gateways goes back to name step without writing to disk', async () => {
    await launchAndNavigateToEngineCreation();

    // Should be on the engine name step. The TextInput has a default value
    // of "MyPolicyEngine". Just accept the default.
    await session!.waitFor('Name', 10000);
    await session!.sendSpecialKey('enter', 1000);

    // Should now be on the "Attach to gateways" screen
    await session!.waitFor('Attach', 10000);

    // Verify we see the gateway name
    const gatewayScreen = session!.readScreen();
    const gatewayText = gatewayScreen.lines.join('\n');
    expect(gatewayText).toContain('TestGateway');

    // NOW press Escape — this is the core of the bug fix test
    await session!.sendSpecialKey('escape', 1000);

    // Should go back to the name step
    const afterEscape = session!.readScreen();
    const afterEscapeText = afterEscape.lines.join('\n');

    // Should NOT see the success screen
    expect(afterEscapeText).not.toContain('Added policy engine');

    // Should be back at the name step (engine wizard)
    // The screen should show the name prompt again
    expect(afterEscapeText).toContain('Name');

    // Verify agentcore.json was NOT modified
    const config = await readConfigFromDisk();
    const engines = config.policyEngines as unknown[];
    expect(engines).toHaveLength(0);
  }, 60000);

  // -----------------------------------------------------------------------
  // Scenario 2: Enter with no selection commits the engine (no gateway attachment)
  // -----------------------------------------------------------------------
  it('Enter with no selection writes engine to agentcore.json without gateway attachment', async () => {
    await launchAndNavigateToEngineCreation();

    await session!.waitFor('Name', 10000);

    // Accept the default engine name "MyPolicyEngine"
    await session!.sendSpecialKey('enter', 1000);

    // Wait for attach gateways screen
    await session!.waitFor('Attach', 10000);

    // Press Enter with NO selection (nothing toggled with Space)
    await session!.sendSpecialKey('enter', 2000);

    // Should see success screen
    await session!.waitFor('Added', 15000);

    const successScreen = session!.readScreen();
    expect(successScreen.lines.join('\n')).toContain('MyPolicyEngine');

    // Verify engine was written to disk
    const config = await readConfigFromDisk();
    const engines = config.policyEngines as { name: string }[];
    expect(engines).toHaveLength(1);
    expect(engines[0]!.name).toBe('MyPolicyEngine');

    // Verify NO gateway attachment
    const gateways = config.agentCoreGateways as { name: string; policyEngineConfiguration?: unknown }[];
    const gw = gateways.find(g => g.name === 'TestGateway');
    expect(gw).toBeDefined();
    expect(gw!.policyEngineConfiguration).toBeUndefined();
  }, 60000);

  // -----------------------------------------------------------------------
  // Scenario 3: Full flow — select gateway, pick mode, both written
  // -----------------------------------------------------------------------
  it('Full flow: select gateway + mode writes engine and gateway attachment', async () => {
    await launchAndNavigateToEngineCreation();

    await session!.waitFor('Name', 10000);

    // Accept the default engine name "MyPolicyEngine"
    await session!.sendSpecialKey('enter', 1000);

    // Wait for attach gateways screen
    await session!.waitFor('Attach', 10000);

    // Toggle the gateway with Space
    await session!.sendKeys(' ', 500);

    // Press Enter to confirm the selection
    await session!.sendSpecialKey('enter', 1000);

    // Should now be on the mode selection screen
    // Wait for enforcement mode options
    try {
      await session!.waitFor('mode', 10000);
    } catch {
      // Try alternate text
      await session!.waitFor('LOG_ONLY', 10000);
    }

    // Select the first mode (LOG_ONLY) by pressing Enter
    await session!.sendSpecialKey('enter', 2000);

    // Should see success screen
    await session!.waitFor('Added', 15000);

    const successScreen = session!.readScreen();
    expect(successScreen.lines.join('\n')).toContain('MyPolicyEngine');

    // Verify engine was written
    const config = await readConfigFromDisk();
    const engines = config.policyEngines as { name: string }[];
    expect(engines).toHaveLength(1);
    expect(engines[0]!.name).toBe('MyPolicyEngine');

    // Verify gateway attachment
    const gateways = config.agentCoreGateways as {
      name: string;
      policyEngineConfiguration?: { policyEngineName: string; mode: string };
    }[];
    const gw = gateways.find(g => g.name === 'TestGateway');
    expect(gw).toBeDefined();
    expect(gw!.policyEngineConfiguration).toBeDefined();
    expect(gw!.policyEngineConfiguration!.policyEngineName).toBe('MyPolicyEngine');
    expect(gw!.policyEngineConfiguration!.mode).toBe('LOG_ONLY');
  }, 60000);
});
