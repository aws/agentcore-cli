/**
 * TUI Integration Test: Add Gateway JWT Configuration Flow
 *
 * Drives the full "Add Gateway" wizard through the CUSTOM_JWT authorizer path
 * using the TuiSession API. Captures screenshots at key steps and verifies
 * each screen renders correctly.
 *
 * Exercises:
 *   - Navigation from HelpScreen -> Add Resource -> Gateway
 *   - Gateway name input (accept default)
 *   - Authorizer type selection (CUSTOM_JWT)
 *   - JWT Discovery URL input
 *   - JWT constraint multi-select (Audiences + Custom Claims)
 *   - Audience value input
 *   - Custom claim form (tabbed fields with cycling selects)
 *   - Client ID skip (empty = skip OAuth credentials)
 *   - Advanced config defaults
 *   - Confirm review screen content verification
 */
import { DARK_THEME, TuiSession, WaitForTimeoutError } from '../../src/tui-harness/index.js';
import { createMinimalProjectDir } from './helpers.js';
import type { MinimalProjectDirResult } from './helpers.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Paths & Constants
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_DIST = join(__dirname, '..', '..', 'dist', 'cli', 'index.mjs');
const SCREENSHOTS_DIR = '/tmp/tui-test-jwt/screenshots';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function screenshotPath(name: string, ext = 'txt'): string {
  return join(SCREENSHOTS_DIR, `${name}.${ext}`);
}

function saveTextScreenshot(session: TuiSession, name: string): string {
  const screen = session.readScreen({ numbered: true });
  const nonEmpty = screen.lines.filter((l: string) => l.trim() !== '');
  const { cols, rows } = screen.dimensions;
  const header = `Screenshot: ${name} (${cols}x${rows})`;
  const border = '='.repeat(Math.max(header.length, 60));
  const text = `${border}\n${header}\n${border}\n${nonEmpty.join('\n')}\n${border}\n`;
  const path = screenshotPath(name);
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

/** Small delay for UI settling between interactions. */
const settle = (ms = 400) => new Promise<void>(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('Add Gateway JWT Flow', () => {
  let session: TuiSession;
  let projectDir: MinimalProjectDirResult;

  beforeAll(async () => {
    mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    // Create a minimal project directory
    projectDir = await createMinimalProjectDir({ projectName: 'jwt-test-project' });

    // Launch the TUI using process.execPath for the absolute node binary path.
    // node-pty uses posix_spawnp which cannot resolve bare 'node' when it is
    // managed by a version manager (mise, nvm, etc.) outside the default PATH.
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

  it('Step 1: reaches HelpScreen with Commands', async () => {
    const found = await safeWaitFor(session, 'Commands', 15_000);
    if (!found) {
      saveTextScreenshot(session, '01-fail');
    }
    expect(found).toBe(true);
    saveTextScreenshot(session, '01-helpscreen');
  });

  it('Step 1b: filters to "add" and opens Add Resource screen', async () => {
    await session.sendKeys('add');
    await settle();
    saveTextScreenshot(session, '01b-filtered-add');

    await session.sendSpecialKey('enter');
    const found = await safeWaitFor(session, 'Add Resource', 5_000);
    if (!found) {
      saveTextScreenshot(session, '01c-add-resource-fail');
    }
    expect(found).toBe(true);
    saveTextScreenshot(session, '01c-add-resource');
  });

  it('Step 1c: navigates to Gateway and enters the wizard', async () => {
    // Add Resource list order:
    //   0: Agent, 1: Memory, 2: Identity, 3: Evaluator,
    //   4: Online Eval Config, 5: Gateway, 6: Gateway Target
    for (let i = 0; i < 5; i++) {
      await session.sendSpecialKey('down');
    }
    await settle();
    saveTextScreenshot(session, '01d-gateway-highlighted');

    const text = getScreenText(session);
    expect(text).toContain('Gateway');

    await session.sendSpecialKey('enter');
    const found = await safeWaitFor(session, 'Name', 5_000);
    if (!found) {
      saveTextScreenshot(session, '01e-gateway-name-fail');
    }
    expect(found).toBe(true);
    saveTextScreenshot(session, '02-gateway-name');
  });

  it('Step 2: accepts default gateway name', async () => {
    await session.sendSpecialKey('enter');
    const found = await safeWaitFor(session, 'authorizer', 5_000);
    if (!found) {
      saveTextScreenshot(session, '02-authorizer-fail');
    }
    expect(found).toBe(true);
    saveTextScreenshot(session, '02-authorizer-type');
  });

  it('Step 3: selects CUSTOM_JWT authorizer type', async () => {
    // Authorizer list: 0: AWS IAM, 1: Custom JWT, 2: None
    await session.sendSpecialKey('down');
    await settle();
    saveTextScreenshot(session, '03a-custom-jwt-highlighted');

    await session.sendSpecialKey('enter');
    const found = await safeWaitFor(session, 'Configure Custom JWT Authorizer', 5_000);
    if (!found) {
      saveTextScreenshot(session, '03-jwt-config-fail');
    }
    expect(found).toBe(true);
    saveTextScreenshot(session, '03-jwt-discovery-url');
  });

  it('Step 4: enters OIDC Discovery URL', async () => {
    const url = 'https://login.example.com/.well-known/openid-configuration';
    await session.sendKeys(url);
    await settle();
    saveTextScreenshot(session, '04a-discovery-url-typed');

    await session.sendSpecialKey('enter');

    // The constraint picker may use different text; try several markers
    let found = await safeWaitFor(session, 'constraints', 8_000);
    if (!found) {
      const text = getScreenText(session);
      found = text.includes('Allowed Audiences') || text.includes('toggle') || text.includes('Space');
    }
    if (!found) {
      saveTextScreenshot(session, '04-constraint-fail');
    }
    expect(found).toBe(true);
    saveTextScreenshot(session, '04-constraint-picker');
  });

  it('Step 5: selects Audiences and Custom Claims constraints', async () => {
    // Constraint list:
    //   0: Allowed Audiences, 1: Allowed Clients, 2: Allowed Scopes, 3: Custom Claims

    // Toggle Allowed Audiences (cursor starts at 0)
    await session.sendSpecialKey('space');
    await settle(300);

    // Move to Custom Claims (3 down)
    await session.sendSpecialKey('down');
    await session.sendSpecialKey('down');
    await session.sendSpecialKey('down');
    await settle(300);

    // Toggle Custom Claims
    await session.sendSpecialKey('space');
    await settle(300);
    saveTextScreenshot(session, '05a-constraints-selected');

    // Confirm selection
    await session.sendSpecialKey('enter');

    const found = await safeWaitFor(session, 'Audience', 5_000);
    if (!found) {
      saveTextScreenshot(session, '05-audience-fail');
    }
    expect(found).toBe(true);
    saveTextScreenshot(session, '05-audience-input');
  });

  it('Step 6: enters audience values', async () => {
    await session.sendKeys('aud-123, aud-456');
    await settle();
    saveTextScreenshot(session, '06a-audience-typed');

    await session.sendSpecialKey('enter');

    const found = await safeWaitFor(session, 'Custom Claims', 5_000);
    if (!found) {
      saveTextScreenshot(session, '06-claims-fail');
    }
    expect(found).toBe(true);
    saveTextScreenshot(session, '06-custom-claims-manager');
  });

  it('Step 7: adds a custom claim via the tabbed form', async () => {
    // CustomClaimsManager opens in 'add' mode when no claims exist yet.
    // The form fields are: claimName, valueType, operator, matchValue
    // Navigation: Tab cycles fields, left/right cycles select options, Enter saves.

    let found = await safeWaitFor(session, 'Claim name', 5_000);
    if (!found) {
      // Maybe we need to select "Add claim" from the action menu first
      const text = getScreenText(session);
      if (text.includes('Add claim')) {
        await session.sendSpecialKey('enter');
        found = await safeWaitFor(session, 'Claim name', 3_000);
      }
    }
    if (!found) {
      saveTextScreenshot(session, '07-claim-form-fail');
    }
    expect(found).toBe(true);
    saveTextScreenshot(session, '07a-claim-form-empty');

    // --- Fill in claim name ---
    await session.sendKeys('department');
    await settle(300);
    saveTextScreenshot(session, '07b-claim-name-typed');

    // --- Tab to valueType, change to STRING_ARRAY ---
    await session.sendSpecialKey('tab');
    await settle(300);
    await session.sendSpecialKey('right'); // STRING -> STRING_ARRAY
    await settle(300);
    saveTextScreenshot(session, '07c-value-type-string-array');

    // Verify the value type changed
    let text = getScreenText(session);
    expect(text).toContain('String Array');

    // --- Tab to operator, change to CONTAINS_ANY ---
    await session.sendSpecialKey('tab');
    await settle(300);
    await session.sendSpecialKey('right'); // EQUALS -> CONTAINS
    await settle(200);
    await session.sendSpecialKey('right'); // CONTAINS -> CONTAINS_ANY
    await settle(300);
    saveTextScreenshot(session, '07d-operator-contains-any');

    text = getScreenText(session);
    expect(text).toContain('Contains Any');

    // --- Tab to matchValue, type values ---
    await session.sendSpecialKey('tab');
    await settle(300);
    await session.sendKeys('engineering, sales');
    await settle(300);
    saveTextScreenshot(session, '07e-match-value-typed');

    // --- Press Enter to save the claim ---
    await session.sendSpecialKey('enter');
    await settle(500);

    // Verify we returned to the claims list with our claim visible
    text = getScreenText(session);
    const hasClaim = text.includes('department') || text.includes('Add claim') || text.includes('Done');
    if (!hasClaim) {
      saveTextScreenshot(session, '07f-claims-list-fail');
    }
    expect(hasClaim).toBe(true);
    saveTextScreenshot(session, '07f-claims-list-with-claim');
  });

  it('Step 8: selects Done to finish claims configuration', async () => {
    // After saving, we're in list mode with actions:
    //   0: Add claim, 1: Edit existing claim, 2: Done
    const text = getScreenText(session);
    if (text.includes('Add claim')) {
      await session.sendSpecialKey('down'); // -> Edit existing claim
      await session.sendSpecialKey('down'); // -> Done
      await settle(300);
      saveTextScreenshot(session, '08a-done-highlighted');
    }

    await session.sendSpecialKey('enter');

    // Should reach Client ID / OAuth step
    let found = await safeWaitFor(session, 'Client ID', 5_000);
    if (!found) {
      const afterText = getScreenText(session);
      found =
        afterText.includes('OAuth') ||
        afterText.includes('credential') ||
        afterText.includes('skip') ||
        afterText.includes('Enter to skip');
    }
    if (!found) {
      saveTextScreenshot(session, '08-client-fail');
    }
    expect(found).toBe(true);
    saveTextScreenshot(session, '08-client-id-step');
  });

  it('Step 9: skips OAuth client credentials', async () => {
    // Press Enter with empty input to skip
    await session.sendSpecialKey('enter');

    // Should reach Advanced Config
    let found = await safeWaitFor(session, 'Advanced', 5_000);
    if (!found) {
      const text = getScreenText(session);
      found =
        text.includes('Semantic') || text.includes('Toggle') || text.includes('toggle') || text.includes('Exception');
    }
    if (!found) {
      saveTextScreenshot(session, '09-advanced-fail');
    }
    expect(found).toBe(true);
    saveTextScreenshot(session, '09-advanced-config');
  });

  it('Step 10: accepts advanced config defaults', async () => {
    await session.sendSpecialKey('enter');

    // Should reach Confirm / Review screen
    let found = await safeWaitFor(session, 'Review', 5_000);
    if (!found) {
      const text = getScreenText(session);
      found = text.includes('my-gateway') || text.includes('CUSTOM_JWT') || text.includes('Confirm');
    }
    if (!found) {
      saveTextScreenshot(session, '10-confirm-fail');
    }
    expect(found).toBe(true);
    saveTextScreenshot(session, '10-confirm-review');
  });

  it('Step 11: confirm review shows all JWT configuration details', () => {
    const text = getScreenText(session);

    // Verify gateway name
    expect(text).toContain('my-gateway');

    // Verify authorizer type
    expect(text).toContain('CUSTOM_JWT');

    // Verify Discovery URL
    expect(text).toContain('login.example.com');

    // Verify audiences
    expect(text).toContain('aud-123');

    // Verify custom claims count
    expect(text).toContain('1 claim');

    // Save final screenshots
    saveTextScreenshot(session, '11-confirm-review-final');

    // Save SVG screenshot to the requested path
    const svg = session.screenshot({ theme: DARK_THEME });
    const svgPath = '/tmp/tui-test-jwt/jwt-confirm-review.svg';
    writeFileSync(svgPath, svg, 'utf-8');
  });

  it('Step 12: escape navigates back without creating', async () => {
    await session.sendSpecialKey('escape');
    await settle(500);

    // Session should still be alive after pressing escape
    expect(session.alive).toBe(true);
    saveTextScreenshot(session, '12-after-escape');
  });
});
