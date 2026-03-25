/**
 * TUI Integration Test: Lifecycle Configuration in Create and Add Agent flows
 *
 * Drives the TUI through both:
 *   1. `create` wizard (GenerateWizard) — advanced settings with lifecycle config
 *   2. `add agent` BYO flow (AddAgentScreen) — advanced settings with lifecycle config
 *
 * Verifies lifecycle values end up in agentcore.json after confirmation.
 */
import { TuiSession, WaitForTimeoutError } from '../../src/tui-harness/index.js';
import { createMinimalProjectDir } from './helpers.js';
import type { MinimalProjectDirResult } from './helpers.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Paths & Constants
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_DIST = join(__dirname, '..', '..', 'dist', 'cli', 'index.mjs');
const SCREENSHOTS_DIR = '/tmp/tui-test-lifecycle/screenshots';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function saveTextScreenshot(session: TuiSession, name: string): string {
  const screen = session.readScreen({ numbered: true });
  const nonEmpty = screen.lines.filter((l: string) => l.trim() !== '');
  const { cols, rows } = screen.dimensions;
  const header = `Screenshot: ${name} (${cols}x${rows})`;
  const border = '='.repeat(Math.max(header.length, 60));
  const text = `${border}\n${header}\n${border}\n${nonEmpty.join('\n')}\n${border}\n`;
  const path = join(SCREENSHOTS_DIR, `${name}.txt`);
  writeFileSync(path, text, 'utf-8');
  return path;
}

function getScreenText(session: TuiSession): string {
  return session.readScreen().lines.join('\n');
}

async function safeWaitFor(session: TuiSession, pattern: string | RegExp, timeoutMs = 10_000): Promise<boolean> {
  try {
    await session.waitFor(pattern, timeoutMs);
    return true;
  } catch (err) {
    if (err instanceof WaitForTimeoutError) {
      return false;
    }
    throw err;
  }
}

const settle = (ms = 400) => new Promise<void>(r => setTimeout(r, ms));

function readAgentcoreJson(projectDir: string): Record<string, unknown> {
  const path = join(projectDir, 'agentcore', 'agentcore.json');
  return JSON.parse(readFileSync(path, 'utf-8'));
}

// ---------------------------------------------------------------------------
// Test Suite: Create Flow with Lifecycle Config
// ---------------------------------------------------------------------------

describe('Create Flow: Lifecycle Configuration via TUI', () => {
  let session: TuiSession;
  let _tmpDir: string;

  beforeAll(() => {
    mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  });

  afterEach(async () => {
    if (session?.alive) {
      await session.close();
    }
  });

  it('lifecycle config flows from create wizard advanced settings into agentcore.json', async () => {
    // Create a temp directory for the new project
    const { dir: parentDir, cleanup } = await createMinimalProjectDir({ projectName: 'lifecycle-create-test' });

    try {
      // Launch the CLI in "create" mode directly
      session = await TuiSession.launch({
        command: process.execPath,
        args: [
          CLI_DIST,
          'create',
          '--name',
          'LcTuiCreate',
          '--language',
          'Python',
          '--framework',
          'Strands',
          '--model-provider',
          'Bedrock',
          '--memory',
          'none',
        ],
        cwd: parentDir,
        cols: 120,
        rows: 35,
      });

      // Should reach the "Advanced" step (yes/no)
      const atAdvanced = await safeWaitFor(session, 'Advanced', 15_000);
      if (!atAdvanced) {
        saveTextScreenshot(session, 'create-01-advanced-fail');
      }
      expect(atAdvanced, 'Should reach Advanced config step').toBe(true);
      saveTextScreenshot(session, 'create-01-advanced');

      // Select "Yes" for advanced (first option)
      await session.sendSpecialKey('enter');
      const atNetworkMode = await safeWaitFor(session, 'Network', 5_000);
      if (!atNetworkMode) {
        saveTextScreenshot(session, 'create-02-network-fail');
      }
      expect(atNetworkMode, 'Should reach network mode step').toBe(true);
      saveTextScreenshot(session, 'create-02-network');

      // Select PUBLIC (first option)
      await session.sendSpecialKey('enter');

      // Should reach request header allowlist step
      const _atHeaders = await safeWaitFor(session, /header|allowlist/i, 5_000);
      saveTextScreenshot(session, 'create-03-headers');

      // Skip headers (Enter with empty)
      await session.sendSpecialKey('enter');

      // Should reach idle timeout step
      const atIdleTimeout = await safeWaitFor(session, /idle.*timeout/i, 5_000);
      if (!atIdleTimeout) {
        saveTextScreenshot(session, 'create-04-idle-fail');
      }
      expect(atIdleTimeout, 'Should reach idle timeout step').toBe(true);
      saveTextScreenshot(session, 'create-04-idle-timeout');

      // Enter idle timeout value: 120
      await session.sendKeys('120');
      await settle(300);
      await session.sendSpecialKey('enter');

      // Should reach max lifetime step
      const atMaxLifetime = await safeWaitFor(session, /max.*lifetime/i, 5_000);
      if (!atMaxLifetime) {
        saveTextScreenshot(session, 'create-05-maxlife-fail');
      }
      expect(atMaxLifetime, 'Should reach max lifetime step').toBe(true);
      saveTextScreenshot(session, 'create-05-max-lifetime');

      // Enter max lifetime value: 3600
      await session.sendKeys('3600');
      await settle(300);
      await session.sendSpecialKey('enter');

      // Should reach confirm step
      const atConfirm = await safeWaitFor(session, /confirm|review/i, 5_000);
      if (!atConfirm) {
        saveTextScreenshot(session, 'create-06-confirm-fail');
      }
      expect(atConfirm, 'Should reach confirm step').toBe(true);
      saveTextScreenshot(session, 'create-06-confirm');

      // Verify the review screen shows lifecycle values
      const reviewText = getScreenText(session);
      expect(reviewText).toContain('120');
      expect(reviewText).toContain('3600');

      // Confirm the creation (press Enter or 'y')
      await session.sendKeys('y');

      // Wait for project creation to complete
      const created = await safeWaitFor(session, /created|success|Commands/i, 30_000);
      saveTextScreenshot(session, 'create-07-result');

      if (created) {
        // Find the created project directory
        const { readdirSync } = await import('node:fs');
        const entries = readdirSync(parentDir);
        const projectDirName = entries.find(e => e.startsWith('LcTuiCreate') || e === 'LcTuiCreate');
        if (projectDirName) {
          const projectPath = join(parentDir, projectDirName);
          const config = readAgentcoreJson(projectPath);
          const agents = config.agents as Record<string, unknown>[];
          expect(agents.length).toBeGreaterThan(0);

          const agent = agents[0]!;
          const lifecycle = agent.lifecycleConfiguration as Record<string, unknown>;
          expect(lifecycle, 'agentcore.json should have lifecycleConfiguration').toBeDefined();
          expect(lifecycle.idleRuntimeSessionTimeout).toBe(120);
          expect(lifecycle.maxLifetime).toBe(3600);
        }
      }
    } finally {
      await cleanup();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Test Suite: Add Agent BYO Flow with Lifecycle Config
// ---------------------------------------------------------------------------

describe('Add Agent BYO Flow: Lifecycle Configuration via TUI', () => {
  let session: TuiSession;
  let projectDir: MinimalProjectDirResult;

  beforeAll(async () => {
    mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    projectDir = await createMinimalProjectDir({ projectName: 'lifecycle-byo-test' });
  });

  afterAll(async () => {
    if (session?.alive) {
      await session.close();
    }
    if (projectDir) {
      await projectDir.cleanup();
    }
  });

  it('Step 1: launch TUI and navigate to Add Agent', async () => {
    session = await TuiSession.launch({
      command: process.execPath,
      args: [CLI_DIST],
      cwd: projectDir.dir,
      cols: 120,
      rows: 35,
    });

    const found = await safeWaitFor(session, 'Commands', 15_000);
    if (!found) {
      saveTextScreenshot(session, 'byo-01-commands-fail');
    }
    expect(found).toBe(true);
    saveTextScreenshot(session, 'byo-01-helpscreen');

    // Filter to "add" and open
    await session.sendKeys('add');
    await settle();
    await session.sendSpecialKey('enter');

    const atAdd = await safeWaitFor(session, 'Add Resource', 5_000);
    expect(atAdd).toBe(true);
    saveTextScreenshot(session, 'byo-02-add-resource');

    // Select Agent (first option)
    await session.sendSpecialKey('enter');

    const atAgent = await safeWaitFor(session, /agent|Name/i, 5_000);
    expect(atAgent).toBe(true);
    saveTextScreenshot(session, 'byo-03-add-agent');
  });

  it('Step 2: select BYO agent type and enter name', async () => {
    // The add agent screen first asks for type: Template or BYO
    // Check if we see a type selector
    const text = getScreenText(session);

    if (text.includes('Template') || text.includes('BYO') || text.includes('Bring')) {
      // Navigate to BYO option (should be second)
      await session.sendSpecialKey('down');
      await settle();
      await session.sendSpecialKey('enter');
      await settle();
    }

    // Now should be at name entry
    const _atName = await safeWaitFor(session, /name/i, 5_000);
    saveTextScreenshot(session, 'byo-04-name');

    // Enter agent name
    await session.sendKeys('ByoLifecycle');
    await settle(300);
    await session.sendSpecialKey('enter');

    await settle(500);
    saveTextScreenshot(session, 'byo-05-after-name');
  });

  it('Step 3: navigate through BYO config to advanced settings', async () => {
    // After name, BYO agents ask for: language, buildType, protocol, framework, modelProvider,
    // codeLocation, entrypoint, then advanced

    // Language (Python first)
    let found = await safeWaitFor(session, /language|Python/i, 5_000);
    if (found) {
      await session.sendSpecialKey('enter'); // select Python
      await settle();
    }
    saveTextScreenshot(session, 'byo-06-language');

    // Build type (CodeZip first)
    found = await safeWaitFor(session, /build|CodeZip/i, 3_000);
    if (found) {
      await session.sendSpecialKey('enter'); // select CodeZip
      await settle();
    }
    saveTextScreenshot(session, 'byo-07-build');

    // Protocol (HTTP first)
    found = await safeWaitFor(session, /protocol|HTTP/i, 3_000);
    if (found) {
      await session.sendSpecialKey('enter'); // select HTTP
      await settle();
    }
    saveTextScreenshot(session, 'byo-08-protocol');

    // Framework
    found = await safeWaitFor(session, /framework|Strands/i, 3_000);
    if (found) {
      await session.sendSpecialKey('enter'); // select Strands
      await settle();
    }
    saveTextScreenshot(session, 'byo-09-framework');

    // Model provider
    found = await safeWaitFor(session, /model.*provider|Bedrock/i, 3_000);
    if (found) {
      await session.sendSpecialKey('enter'); // select Bedrock
      await settle();
    }
    saveTextScreenshot(session, 'byo-10-model-provider');

    // Runtime version
    found = await safeWaitFor(session, /runtime.*version|PYTHON/i, 3_000);
    if (found) {
      await session.sendSpecialKey('enter');
      await settle();
    }
    saveTextScreenshot(session, 'byo-11-runtime-version');

    // Code location
    found = await safeWaitFor(session, /code.*location|directory/i, 3_000);
    if (found) {
      await session.sendSpecialKey('enter'); // accept default
      await settle();
    }
    saveTextScreenshot(session, 'byo-12-code-location');

    // Entrypoint
    found = await safeWaitFor(session, /entrypoint|main/i, 3_000);
    if (found) {
      await session.sendSpecialKey('enter'); // accept default
      await settle();
    }
    saveTextScreenshot(session, 'byo-13-entrypoint');

    // Should reach Advanced
    const atAdvanced = await safeWaitFor(session, /advanced/i, 5_000);
    saveTextScreenshot(session, 'byo-14-advanced');
    expect(atAdvanced, 'Should reach Advanced config').toBe(true);
  });

  it('Step 4: enable advanced settings and enter lifecycle config', async () => {
    // Select "Yes" for advanced config
    await session.sendSpecialKey('enter');
    await settle();
    saveTextScreenshot(session, 'byo-15-after-advanced-yes');

    // Network mode — select PUBLIC
    let found = await safeWaitFor(session, /network/i, 5_000);
    if (found) {
      await session.sendSpecialKey('enter');
      await settle();
    }
    saveTextScreenshot(session, 'byo-16-network');

    // Request header allowlist — skip
    found = await safeWaitFor(session, /header|allowlist/i, 3_000);
    if (found) {
      await session.sendSpecialKey('enter');
      await settle();
    }
    saveTextScreenshot(session, 'byo-17-headers');

    // Idle timeout step
    found = await safeWaitFor(session, /idle.*timeout/i, 5_000);
    if (!found) {
      saveTextScreenshot(session, 'byo-18-idle-fail');
    }
    expect(found, 'Should reach idle timeout step').toBe(true);
    saveTextScreenshot(session, 'byo-18-idle-timeout');

    // Enter idle timeout: 600
    await session.sendKeys('600');
    await settle(300);
    await session.sendSpecialKey('enter');

    // Max lifetime step
    found = await safeWaitFor(session, /max.*lifetime/i, 5_000);
    if (!found) {
      saveTextScreenshot(session, 'byo-19-maxlife-fail');
    }
    expect(found, 'Should reach max lifetime step').toBe(true);
    saveTextScreenshot(session, 'byo-19-max-lifetime');

    // Enter max lifetime: 14400
    await session.sendKeys('14400');
    await settle(300);
    await session.sendSpecialKey('enter');

    // Should reach confirm/review
    found = await safeWaitFor(session, /confirm|review/i, 5_000);
    if (!found) {
      saveTextScreenshot(session, 'byo-20-confirm-fail');
    }
    expect(found, 'Should reach confirm step').toBe(true);
    saveTextScreenshot(session, 'byo-20-confirm');
  });

  it('Step 5: review shows lifecycle values and confirm writes to agentcore.json', async () => {
    // Verify the review screen shows lifecycle values
    const reviewText = getScreenText(session);
    expect(reviewText).toContain('600');
    expect(reviewText).toContain('14400');
    saveTextScreenshot(session, 'byo-21-review-values');

    // Confirm
    await session.sendKeys('y');
    await settle(1000);

    // Wait for the agent to be added
    const _done = await safeWaitFor(session, /added|success|Commands/i, 10_000);
    saveTextScreenshot(session, 'byo-22-after-confirm');

    // Read the agentcore.json and verify lifecycle config
    const config = readAgentcoreJson(projectDir.dir);
    const agents = config.agents as Record<string, unknown>[];
    const agent = agents.find((a: Record<string, unknown>) => a.name === 'ByoLifecycle');
    expect(agent, 'Agent should be in agentcore.json').toBeDefined();

    const lifecycle = agent!.lifecycleConfiguration as Record<string, unknown>;
    expect(lifecycle, 'Should have lifecycleConfiguration in agentcore.json').toBeDefined();
    expect(lifecycle.idleRuntimeSessionTimeout).toBe(600);
    expect(lifecycle.maxLifetime).toBe(14400);
  });
});
