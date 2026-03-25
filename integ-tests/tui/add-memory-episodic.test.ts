/**
 * TUI Integration Test: Add Memory with EPISODIC Strategy
 *
 * Drives the "Add Memory" wizard through the TUI to verify that when a user
 * selects the EPISODIC strategy, it is correctly persisted in agentcore.json
 * with both namespaces and reflectionNamespaces.
 *
 * Exercises:
 *   - Navigation from HelpScreen -> Add Resource -> Memory
 *   - Memory name input
 *   - Expiry selection (default 30 days)
 *   - Strategy multi-select including EPISODIC
 *   - Confirm review screen
 *   - Verification that agentcore.json contains EPISODIC with reflectionNamespaces
 */
import { TuiSession, WaitForTimeoutError } from '../../src/tui-harness/index.js';
import { createMinimalProjectDir } from './helpers.js';
import type { MinimalProjectDirResult } from './helpers.js';
import { readFile as readFileAsync } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Paths & Constants
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_DIST = join(__dirname, '..', '..', 'dist', 'cli', 'index.mjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('Add Memory with EPISODIC Strategy', () => {
  let session: TuiSession;
  let projectDir: MinimalProjectDirResult;

  beforeAll(async () => {
    projectDir = await createMinimalProjectDir({ projectName: 'episodic-test' });

    session = await TuiSession.launch({
      command: process.execPath,
      args: [CLI_DIST],
      cwd: projectDir.dir,
      cols: 120,
      rows: 35,
    });
  });

  afterAll(async () => {
    if (session?.alive) {
      await session.close();
    }
    if (projectDir) {
      await projectDir.cleanup();
    }
  });

  it('Step 1: reaches HelpScreen', async () => {
    const found = await safeWaitFor(session, 'Commands', 15_000);
    expect(found).toBe(true);
  });

  it('Step 2: navigates to Add Resource screen', async () => {
    await session.sendKeys('add');
    await settle();
    await session.sendSpecialKey('enter');
    const found = await safeWaitFor(session, 'Add Resource', 5_000);
    expect(found).toBe(true);
  });

  it('Step 3: selects Memory from the resource list', async () => {
    // Add Resource list: 0: Agent, 1: Memory
    await session.sendSpecialKey('down');
    await settle();

    const text = getScreenText(session);
    expect(text).toContain('Memory');

    await session.sendSpecialKey('enter');
    const found = await safeWaitFor(session, 'Name', 5_000);
    expect(found).toBe(true);
  });

  it('Step 4: enters memory name', async () => {
    await session.sendKeys('EpisodicTestMemory');
    await settle();
    await session.sendSpecialKey('enter');

    const found = await safeWaitFor(session, /[Ee]xpiry|days/, 5_000);
    expect(found).toBe(true);
  });

  it('Step 5: selects default expiry (30 days)', async () => {
    // Default is 30 days, just press enter
    await session.sendSpecialKey('enter');
    await settle();

    // Should reach strategies multi-select
    const found = await safeWaitFor(session, /[Ss]trateg/, 5_000);
    expect(found).toBe(true);
  });

  it('Step 6: selects all strategies including EPISODIC', async () => {
    // Strategy list order matches enum: SEMANTIC, SUMMARIZATION, USER_PREFERENCE, EPISODIC
    // Toggle SEMANTIC (cursor starts at 0)
    await session.sendSpecialKey('space');
    await settle(200);

    // Toggle SUMMARIZATION
    await session.sendSpecialKey('down');
    await session.sendSpecialKey('space');
    await settle(200);

    // Toggle USER_PREFERENCE
    await session.sendSpecialKey('down');
    await session.sendSpecialKey('space');
    await settle(200);

    // Toggle EPISODIC
    await session.sendSpecialKey('down');
    await session.sendSpecialKey('space');
    await settle(200);

    // Verify EPISODIC is visible on screen
    const text = getScreenText(session);
    expect(text).toContain('Episodic');

    // Confirm selection
    await session.sendSpecialKey('enter');

    // Should reach confirm/review screen
    const found = await safeWaitFor(session, /[Rr]eview|[Cc]onfirm/, 5_000);
    expect(found).toBe(true);
  });

  it('Step 7: confirm screen shows EPISODIC strategy', () => {
    const text = getScreenText(session);

    // Verify all strategies appear in the review
    expect(text).toContain('SEMANTIC');
    expect(text).toContain('EPISODIC');
    expect(text).toContain('EpisodicTestMemory');
  });

  it('Step 8: confirms and creates memory', async () => {
    await session.sendSpecialKey('enter');
    await settle(1000);

    // Should return to HelpScreen or show success
    const found = await safeWaitFor(session, /Commands|[Ss]uccess|added/, 10_000);
    expect(found).toBe(true);
  });

  it('Step 9: agentcore.json contains EPISODIC with reflectionNamespaces', async () => {
    const configPath = join(projectDir.dir, 'agentcore', 'agentcore.json');
    const raw = await readFileAsync(configPath, 'utf-8');
    const config = JSON.parse(raw);

    const memories = config.memories as {
      name: string;
      strategies: { type: string; namespaces?: string[]; reflectionNamespaces?: string[] }[];
    }[];
    expect(memories.length).toBeGreaterThan(0);

    const memory = memories.find(m => m.name === 'EpisodicTestMemory');
    expect(memory, 'EpisodicTestMemory should exist in agentcore.json').toBeTruthy();

    // Verify all 4 strategies present
    const types = memory!.strategies.map(s => s.type);
    expect(types).toContain('SEMANTIC');
    expect(types).toContain('SUMMARIZATION');
    expect(types).toContain('USER_PREFERENCE');
    expect(types).toContain('EPISODIC');

    // Verify EPISODIC has namespaces AND reflectionNamespaces
    const episodic = memory!.strategies.find(s => s.type === 'EPISODIC');
    expect(episodic, 'EPISODIC strategy should exist').toBeTruthy();
    expect(episodic!.namespaces, 'EPISODIC should have namespaces').toBeDefined();
    expect(episodic!.namespaces!.length).toBeGreaterThan(0);
    expect(episodic!.reflectionNamespaces, 'EPISODIC should have reflectionNamespaces').toBeDefined();
    expect(episodic!.reflectionNamespaces!.length).toBeGreaterThan(0);
  });
});
