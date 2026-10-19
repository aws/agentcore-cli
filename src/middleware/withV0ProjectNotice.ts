import { enclosingProjectRoot, isV0Project } from "../core/project/fsUtils";
import type { AppIO } from "../io";
import type { Middleware } from "../router";
import { V0ProjectDetectedKey, V0ProjectNoticeStateKey } from "../handlers/project/context";
import { V0_PROJECT_MIGRATION_MESSAGE } from "../handlers/project/v0Notice";

/**
 * Marks commands launched from a v0 project and reminds direct-command users
 * to migrate. TUI sessions render the reminder themselves after restoring the
 * normal terminal buffer.
 */
export function withV0ProjectNotice(io: AppIO): Middleware {
  return (h) => ({
    name: () => h.name(),
    description: () => h.description(),
    flags: () => h.flags(),
    arguments: () => h.arguments(),
    doesSupportTui: () => h.doesSupportTui(),
    children: () => h.children(),
    handle: async (ctx, flags, args) => {
      const rootPath = enclosingProjectRoot(process.cwd());
      if (!rootPath || !(await isV0Project(rootPath))) {
        await h.handle(ctx, flags, args);
        return;
      }

      const state = { enteredTui: false };
      const nextCtx = ctx
        .withValue(V0ProjectDetectedKey, true)
        .withValue(V0ProjectNoticeStateKey, state);
      try {
        await h.handle(nextCtx, flags, args);
      } finally {
        if (!state.enteredTui && h.name() !== "migrate") {
          io.stderr.write(`${V0_PROJECT_MIGRATION_MESSAGE}\n`);
        }
      }
    },
  });
}
