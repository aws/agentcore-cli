import { enclosingProjectRoot, isV0Project } from "../core/project/fsUtils";
import { ProjectStateError } from "../errors";
import type { Middleware } from "../router";

export const V0_PROJECT_ADD_REMOVE_MESSAGE =
  "This project uses the v0 format (agentcore.json version 1). " +
  "The v1 CLI cannot add or remove resources in it. " +
  "Use 'agentcore migrate' to migrate the project fully before adding or removing resources.";

/** Blocks project add/remove before withProject attempts to parse the v1 schema. */
export function withV0ProjectGuard(): Middleware {
  return (h) => ({
    name: () => h.name(),
    description: () => h.description(),
    flags: () => h.flags(),
    arguments: () => h.arguments(),
    doesSupportTui: () => h.doesSupportTui(),
    children: () => h.children(),
    handle: async (ctx, flags, args) => {
      const rootPath = enclosingProjectRoot(process.cwd());
      if (rootPath && (await isV0Project(rootPath))) {
        throw new ProjectStateError(V0_PROJECT_ADD_REMOVE_MESSAGE);
      }
      await h.handle(ctx, flags, args);
    },
  });
}
