import type { DatasetSchemaType } from "@aws-sdk/client-bedrock-agentcore-control";
import type { InlineGroundTruth } from "@aws-sdk/client-bedrock-agentcore";

export type TurnResult = { text: string };

// The per-session transport handed to run(): one call = one turn. Session id, auth, and
// templating are bound by the caller, so an example only decides what to say next.
export type RunContext = { invokeOnce: (payload: string) => Promise<TurnResult> };

// An interface, not a base class: no shared state to inherit, and the machine dispatches
// by calling run().
export interface Example {
  readonly schemaType: DatasetSchemaType;
  readonly exampleId: string;
  run(ctx: RunContext): Promise<InlineGroundTruth | undefined>;
}
