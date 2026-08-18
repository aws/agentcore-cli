import type { DatasetSchemaType } from "@aws-sdk/client-bedrock-agentcore-control";
import type { InlineGroundTruth } from "@aws-sdk/client-bedrock-agentcore";

// TurnResult is the agent's reply to one turn. A record (not a bare string) so a future
// tool-branching dataset type can widen it by a field without touching every example.
export type TurnResult = { text: string };

// RunContext is the per-session transport handed to run(): one call = one turn. The
// session id, auth, and payload templating are bound by the caller (the machine), so an
// example only decides what to say next, never how the request is built.
export type RunContext = { invokeOnce: (payload: string) => Promise<TurnResult> };

// Example is the contract each dataset type implements: identity plus a self-describing
// run. An interface, not a base class — there is no shared state or behaviour to inherit,
// and the machine dispatches by calling run(), so nothing needs a common superclass.
export interface Example {
  readonly schemaType: DatasetSchemaType;
  readonly exampleId: string;
  run(ctx: RunContext): Promise<InlineGroundTruth | undefined>;
}
