import type { CoreEvalClient } from "./eval/types.tsx";
import type { CoreHarnessClient } from "./harness/types.tsx";
import type { CoreIdentityClient } from "./identity/types.tsx";
import type { CoreOnlineEvalClient } from "./eval/online-eval/types.tsx";
import type { CoreRuntimeClient } from "./runtime/types.tsx";
import type { Context } from "../router";
import type { ProjectManager } from "./project/types.ts";

export interface Core {
  harness: CoreHarnessClient;
  identity: CoreIdentityClient;
  runtime: CoreRuntimeClient;
  eval: CoreEvalClient;
  onlineEval: CoreOnlineEvalClient;
  projectManager: ProjectManager;
}

// ScreenProps is the common prop set every TUI screen receives. `ctx` carries the
// request context (resolved flags, command, path) and `core` the service clients,
// both threaded down by Root.
export interface ScreenProps {
  ctx: Context;
  core: Core;
}
