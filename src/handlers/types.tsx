import type { CoreEvalClient } from "./eval/types.tsx";
import type { CoreGatewayClient } from "./gateway/types.tsx";
import type { CorePolicyClient } from "./gateway/policy/types.tsx";
import type { CoreHarnessClient } from "./harness/types.tsx";
import type { CoreIdentityClient } from "./identity/types.tsx";
import type { CoreMemoryClient } from "./memory/types.tsx";
import type { CoreObservabilityClient } from "../core/observability/types.ts";
import type { CoreRuntimeClient } from "./runtime/types.tsx";
import type { Context } from "../router";
import type { CoreFetch } from "../core/types";
import type { ProjectManager } from "./project/types.ts";
import type { CoreBedrockAgentImporter } from "../core/project/bedrockAgentImport";

export interface Core {
  harness: CoreHarnessClient;
  identity: CoreIdentityClient;
  memory: CoreMemoryClient;
  runtime: CoreRuntimeClient;
  gateway: CoreGatewayClient;
  eval: CoreEvalClient;
  observability: CoreObservabilityClient;
  policy: CorePolicyClient;
  projectManager: ProjectManager;
  /** Imports an alias-pinned Bedrock Agent definition into owned runtime code. */
  bedrockAgentImporter: CoreBedrockAgentImporter;
  /** Shared outbound HTTP for handlers that call non-AWS APIs directly (e.g. feedback → Aperture). */
  fetch: CoreFetch;
}

// ScreenProps is the common prop set every TUI screen receives. `ctx` carries the
// request context (resolved flags, command, path) and `core` the service clients,
// both threaded down by Root.
export interface ScreenProps {
  ctx: Context;
  core: Core;
}
