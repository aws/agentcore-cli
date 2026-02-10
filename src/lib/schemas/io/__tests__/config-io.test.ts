/* eslint-disable security/detect-non-literal-fs-filename */
import { ConfigIO } from '../config-io.js';
import { NoProjectError } from '../path-resolver.js';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

describe('ConfigIO', () => {
  let testDir: string;
  let originalCwd: string;
  let originalInitCwd: string | undefined;

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-configio-test-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
    originalCwd = process.cwd();
    originalInitCwd = process.env.INIT_CWD;
  });

  afterAll(async () => {
    process.chdir(originalCwd);
    if (originalInitCwd !== undefined) {
      process.env.INIT_CWD = originalInitCwd;
    } else {
      delete process.env.INIT_CWD;
    }
    await rm(testDir, { recursive: true, force: true });
  });

  // Helper to change working directory for tests
  // Clears INIT_CWD since npm sets it and it takes precedence over cwd
  function changeWorkingDir(dir: string): void {
    process.chdir(dir);
    delete process.env.INIT_CWD;
  }

  describe('hasProject()', () => {
    it('returns false when no project exists and no baseDir provided', async () => {
      // Create a directory with no agentcore project
      const emptyDir = join(testDir, `empty-${randomUUID()}`);
      await mkdir(emptyDir, { recursive: true });
      changeWorkingDir(emptyDir);

      const configIO = new ConfigIO();
      expect(configIO.hasProject()).toBe(false);
    });

    it('returns true when baseDir is explicitly provided', () => {
      const explicitDir = join(testDir, `explicit-${randomUUID()}`, 'agentcore');
      const configIO = new ConfigIO({ baseDir: explicitDir });
      expect(configIO.hasProject()).toBe(true);
    });

    it('returns true when project is discovered', async () => {
      // Create a valid project structure
      const projectDir = join(testDir, `project-${randomUUID()}`);
      const agentcoreDir = join(projectDir, 'agentcore');
      await mkdir(agentcoreDir, { recursive: true });
      await writeFile(join(agentcoreDir, 'agentcore.json'), JSON.stringify({ version: '1.0', agents: [] }));

      changeWorkingDir(projectDir);

      const configIO = new ConfigIO();
      expect(configIO.hasProject()).toBe(true);
    });
  });

  describe('issue #94: prevents agentcore directory creation when no project found', () => {
    let emptyDir: string;

    beforeEach(async () => {
      // Create a fresh empty directory for each test
      emptyDir = join(testDir, `empty-${randomUUID()}`);
      await mkdir(emptyDir, { recursive: true });
      changeWorkingDir(emptyDir);
    });

    it('initializeBaseDir() throws NoProjectError when no project exists', async () => {
      const configIO = new ConfigIO();

      await expect(configIO.initializeBaseDir()).rejects.toThrow(NoProjectError);
      expect(existsSync(join(emptyDir, 'agentcore'))).toBe(false);
    });

    it('writeProjectSpec() throws NoProjectError when no project exists', async () => {
      const configIO = new ConfigIO();

      const projectSpec = {
        version: '1.0',
        agents: [],
      };

      await expect(configIO.writeProjectSpec(projectSpec as never)).rejects.toThrow(NoProjectError);
      expect(existsSync(join(emptyDir, 'agentcore'))).toBe(false);
    });

    it('writeMcpSpec() throws NoProjectError when no project exists', async () => {
      const configIO = new ConfigIO();

      // Minimal valid MCP spec structure (validation happens after project check)
      const mcpSpec = {
        agentCoreGateways: [],
      };

      await expect(configIO.writeMcpSpec(mcpSpec)).rejects.toThrow(NoProjectError);
      expect(existsSync(join(emptyDir, 'agentcore'))).toBe(false);
    });

    it('does not create agentcore directory on any write operation', async () => {
      const configIO = new ConfigIO();

      // Try all write operations - all should fail with NoProjectError without creating directory
      // Note: NoProjectError is thrown before schema validation, so data shape doesn't matter
      const operations = [
        () => configIO.initializeBaseDir(),
        () => configIO.writeProjectSpec({ version: '1.0', agents: [] } as never),
        () => configIO.writeMcpSpec({ agentCoreGateways: [] }),
        () => configIO.writeMcpDefs({ tools: {} }),
      ];

      for (const op of operations) {
        try {
          await op();
        } catch {
          // Expected to throw NoProjectError
        }
      }

      expect(existsSync(join(emptyDir, 'agentcore'))).toBe(false);
    });
  });

  describe('allows operations when project is explicitly configured', () => {
    it('initializeBaseDir() succeeds when baseDir is provided', async () => {
      const projectDir = join(testDir, `new-project-${randomUUID()}`);
      const agentcoreDir = join(projectDir, 'agentcore');

      const configIO = new ConfigIO({ baseDir: agentcoreDir });

      await configIO.initializeBaseDir();

      expect(existsSync(agentcoreDir)).toBe(true);
      expect(existsSync(join(agentcoreDir, '.cli'))).toBe(true);
    });
  });
});
