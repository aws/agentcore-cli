import type { DatasetSchemaType } from "@aws-sdk/client-bedrock-agentcore-control";
import { InputValidationError } from "../../../errors";
import type { Example } from "./example/types";
import { PredefinedExample } from "./example/predefined";
import { SimulatedExample } from "./example/simulated";

// Pure parse (no I/O) so it's testable with a plain string; the caller fetches the text.
export class DatasetLoader {
  static load(text: string): Example[] {
    const examples: Example[] = [];
    const seen = new Set<string>();
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch (error) {
        throw new InputValidationError("dataset contains a line that is not valid JSON", {
          cause: error,
        });
      }
      // Reject non-object rows before dereferencing — `null` is valid JSON and would throw.
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new InputValidationError("dataset contains a line that is not a JSON object");
      }
      const row = parsed as Record<string, unknown>;

      // The id joins a session to its ground truth — a missing/duplicate one misassigns it.
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
  // dispatches this way. Refuse a both-row rather than silently dropping the actor profile.
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
