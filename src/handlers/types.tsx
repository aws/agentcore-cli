import type { CoreHarnessClient } from "./harness/types.tsx";
import type { CoreIdentityClient } from "./identity/types.tsx";
import type { CoreRuntimeClient } from "./runtime/types.tsx";
import type { Context } from "../router";
import type { ProjectManager } from "./project/types.ts";

export interface Core {
  harness: CoreHarnessClient;
  identity: CoreIdentityClient;
  runtime: CoreRuntimeClient;
  projectManager: ProjectManager;
}

// AppIO is the set of standard streams the app reads from and writes to. It is
// injected at the edge (createRootHandler, from src/index.ts) and threaded down
// to the TUI renderer and handlers, so nothing reaches for the process streams
// (or console.*) directly. Production wiring passes the real process streams;
// tests pass in-memory fakes to capture output and drive input.
export interface AppIO {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}

// ScreenProps is the common prop set every TUI screen receives. `ctx` carries the
// request context (resolved flags, command, path) and `core` the service clients,
// both threaded down by Root.
export interface ScreenProps {
  ctx: Context;
  core: Core;
}
