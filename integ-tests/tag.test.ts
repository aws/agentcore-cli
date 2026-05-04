import { describe, it } from 'vitest';

/**
 * BLOCKED: The `tag` command has `src/cli/commands/tag/action.ts` + `types.ts`
 * but NO `command.ts` and NO `index.ts`. It is NOT exported from
 * `src/cli/commands/index.ts`, so `agentcore tag ...` is currently an unknown
 * command and cannot be reached via the CLI.
 *
 * Enable this suite once the `tag` subcommand is wired up:
 *   1. Add `src/cli/commands/tag/command.ts` that registers subcommands on the
 *      Commander `program`.
 *   2. Add `src/cli/commands/tag/index.ts` that re-exports `registerTag`.
 *   3. Export `registerTag` from `src/cli/commands/index.ts` and wire it in
 *      `src/cli/cli.ts`.
 *
 * Planned integration coverage (see src/cli/commands/tag/action.ts for the
 * underlying action handlers):
 *   - addTag:           `agentcore tag add --tag <k>=<v> --json`
 *   - removeTag:        `agentcore tag remove --tag <k> --json`
 *   - listTags:         `agentcore tag list --json`
 *   - setDefaultTag:    `agentcore tag set-default --tag <k>=<v> --json`
 *   - removeDefaultTag: `agentcore tag remove-default --tag <k> --json`
 */
describe.skip('integration: tag command (BLOCKED — command not registered)', () => {
  it.skip('addTag writes tag to agentcore.json', () => {
    // TODO: implement once src/cli/commands/tag/command.ts and index.ts exist
  });
  it.skip('removeTag deletes tag from agentcore.json', () => {
    // TODO: implement once the tag command is wired into the CLI
  });
  it.skip('listTags returns JSON array of tags', () => {
    // TODO: implement once the tag command is wired into the CLI
  });
  it.skip('setDefaultTag writes default tag to agentcore.json', () => {
    // TODO: implement once the tag command is wired into the CLI
  });
  it.skip('removeDefaultTag deletes default tag from agentcore.json', () => {
    // TODO: implement once the tag command is wired into the CLI
  });
});
