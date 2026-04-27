import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock registry to break circular dependency
vi.mock('../../../primitives/registry', () => ({
  credentialPrimitive: {},
  ALL_PRIMITIVES: [],
}));

vi.mock('../../../../lib/index.js', () => ({
  ConfigIO: class {
    readProjectSpec = vi.fn();
    writeProjectSpec = vi.fn();
  },
}));

/**
 * Verifies that primitive subcommands (e.g., "remove agent") take priority
 * over the catch-all [subcommand] argument registered in registerRemove().
 *
 * Commander matches named subcommands first regardless of registration order,
 * but this test ensures that contract holds if the registration pattern changes.
 */
describe('remove subcommand priority', () => {
  afterEach(() => vi.restoreAllMocks());

  it('named subcommands are matched before the catch-all', async () => {
    const { Command } = await import('@commander-js/extra-typings');
    const { registerRemove } = await import('../command.js');

    const program = new Command();
    program.exitOverride(); // throw instead of process.exit

    const removeCmd = registerRemove(program);

    // Register a test subcommand AFTER registerRemove (same order as cli.ts)
    const actionSpy = vi.fn();
    removeCmd
      .command('test-resource')
      .description('Test subcommand')
      .option('--name <name>', 'Name')
      .option('--json', 'JSON output')
      .action(actionSpy);

    // Parse "remove test-resource --json" — should hit the named subcommand, not the catch-all
    await program.parseAsync(['remove', 'test-resource', '--json'], { from: 'user' });

    expect(actionSpy).toHaveBeenCalledTimes(1);
  });
});
