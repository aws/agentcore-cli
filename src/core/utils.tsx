import type { ClientConfig, CoreOptions } from "./types";

// toClientConfig translates the caller-facing CoreOptions into the ClientConfig the
// SDK client factories expect. `endpoint` and `credentials` are only set when the
// caller provides them, so the SDK falls back to its default endpoint resolution and
// credential chain otherwise. Shared by all Core sub-clients so they translate
// options consistently.
export function toClientConfig(options: CoreOptions): ClientConfig {
  return {
    region: options.region,
    ...(options.endpointUrl ? { endpoint: options.endpointUrl } : {}),
    ...(options.credentials ? { credentials: options.credentials } : {}),
  };
}
