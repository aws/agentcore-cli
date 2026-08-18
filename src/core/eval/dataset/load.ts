import type { DatasetSchemaType } from "@aws-sdk/client-bedrock-agentcore-control";
import { InputValidationError } from "../../../errors";
import type { Example } from "./types";
import { PredefinedExample } from "./predefined";
import { SimulatedExample } from "./simulated";

// DatasetLoader parses dataset JSONL into Example instances. Pure — no I/O, no AWS — so
// it's unit-testable with a plain string; fetching the text (local file or dataset id) is
// the caller's job.
export class DatasetLoader {
  static load(text: string): Example[] {
    const examples: Example[] = [];
    const seen = new Set<string>();
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        throw new InputValidationError("dataset contains a line that is not valid JSON");
      }

      // The id is the join key between a session and its ground truth, so a missing or
      // duplicate id silently misassigns ground truth to the wrong session.
      const exampleId = String(row.example_id ?? row.scenario_id ?? "");
      if (!exampleId) {
        throw new InputValidationError("dataset example is missing 'example_id'");
      }
      if (seen.has(exampleId)) {
        throw new InputValidationError(`dataset has a duplicate example_id: "${exampleId}"`);
      }
      seen.add(exampleId);

      examples.push(DatasetLoader.build(row, exampleId));
    }
    if (examples.length === 0) throw new InputValidationError("dataset has no examples");
    return examples;
  }

  // Classify by row shape — a local JSONL carries no schemaType, and AWS's own SDK
  // dispatches this way, so a file the SDK accepts this CLI must accept too. Refuse a
  // both-row: AWS's `if "turns" in raw` silently drops the actor profile, which reads as
  // a passing run of the wrong test.
  private static build(row: Record<string, unknown>, exampleId: string): Example {
    const hasTurns = Array.isArray(row.turns);
    const hasActor = row.actor_profile != null;
    if (hasTurns && hasActor) {
      throw new InputValidationError(
        `example "${exampleId}" has both 'turns' and 'actor_profile' — one row cannot be both`,
      );
    }
    if (!hasTurns && !hasActor) {
      throw new InputValidationError(
        `example "${exampleId}" has neither 'turns' nor 'actor_profile'`,
      );
    }

    // `: DatasetSchemaType` types the scrutinee as the full SDK enum, so when a member is
    // added the switch stops being exhaustive, build can reach its end without returning,
    // and the compiler flags it (TS2366). The `new X(exampleId, row)` sites enforce the
    // constructor shape — no map, no assertNever.
    const schemaType: DatasetSchemaType = hasTurns
      ? "AGENTCORE_EVALUATION_PREDEFINED_V1"
      : "AGENTCORE_EVALUATION_SIMULATED_V1";
    switch (schemaType) {
      case "AGENTCORE_EVALUATION_PREDEFINED_V1":
        return new PredefinedExample(exampleId, row);
      case "AGENTCORE_EVALUATION_SIMULATED_V1":
        return new SimulatedExample(exampleId, row);
    }
  }
}
