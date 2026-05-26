/**
 * TUI Integration Test: Create flow with TypeScript + Strands
 *
 * Drives the TUI `create` wizard through the basic path with
 * `--language TypeScript --framework Strands`, confirms the scaffold
 * completes, and verifies agentcore.json ends up with
 * runtimeVersion === "NODE_22" and entrypoint === "main.ts".
 */
import { TuiSession, WaitForTimeoutError } from '../../src/tui-harness/index.js';
import { createMinimalProjectDir } from './helpers.js';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_DIST = join(__dirname, '..', '..', 'dist', 'cli', 'index.mjs');
const SCREENSHOTS_DIR = '/tmp/tui-test-create-typescript/screenshots';

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

async function safeWaitFor(session: TuiSession, pattern: string | RegExp, timeoutMs = 10_000): Promise<boolean> {
  try {
    await session.waitFor(pattern, timeoutMs);
    return true;
  } catch (err) {
    if (err instanceof WaitForTimeoutError) return false;
    throw err;
  }
}

function readAgentcoreJson(projectDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(projectDir, 'agentcore', 'agentcore.json'), 'utf-8'));
}

describe('Create Flow: TypeScript + Strands via TUI', () => {
  let session: TuiSession;

  beforeAll(() => {
    mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  });

  afterEach(async () => {
    if (session?.alive) await session.close();
  });

  it('scaffolds a TypeScript Strands agent with runtimeVersion NODE_22 and entrypoint main.ts', async () => {
    const { dir: parentDir, cleanup } = await createMinimalProjectDir({ projectName: 'ts-create-test' });

    try {
      session = await TuiSession.launch({
        command: process.execPath,
        args: [
          CLI_DIST,
          'create',
          '--name',
          'TsTuiCreate',
          '--language',
          'TypeScript',
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
        env: { AGENTCORE_SKIP_INSTALL: '1' },
      });

      const atAdvanced = await safeWaitFor(session, 'Advanced', 15_000);
      if (!atAdvanced) saveTextScreenshot(session, 'ts-01-advanced-fail');
      expect(atAdvanced, 'Should reach Advanced config step').toBe(true);
      saveTextScreenshot(session, 'ts-01-advanced');

      await session.sendSpecialKey('down');
      await session.sendSpecialKey('enter');

      const atConfirm = await safeWaitFor(session, /confirm|review/i, 10_000);
      if (!atConfirm) saveTextScreenshot(session, 'ts-02-confirm-fail');
      expect(atConfirm, 'Should reach confirm step').toBe(true);
      saveTextScreenshot(session, 'ts-02-confirm');

      await session.sendKeys('y');

      const created = await safeWaitFor(session, /created|success|Commands/i, 30_000);
      saveTextScreenshot(session, 'ts-03-result');
      expect(created, 'Scaffold should complete').toBe(true);

      const entries = readdirSync(parentDir);
      const projectDirName = entries.find(e => e.startsWith('TsTuiCreate') || e === 'TsTuiCreate');
      expect(projectDirName, 'Project directory should exist').toBeDefined();

      const projectPath = join(parentDir, projectDirName!);
      const config = readAgentcoreJson(projectPath);
      const agents = config.runtimes as Record<string, unknown>[];
      expect(agents.length).toBeGreaterThan(0);

      const agent = agents[0]!;
      expect(agent.runtimeVersion).toBe('NODE_22');
      expect(agent.entrypoint).toBe('main.ts');
    } finally {
      await cleanup();
    }
  }, 60_000);
});
