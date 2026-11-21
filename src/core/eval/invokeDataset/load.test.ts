import { describe, expect, test } from "bun:test";
import { InputValidationError } from "../../../errors";
import { PredefinedExample } from "./example/predefined";
import { DatasetLoader } from "./load";

describe("DatasetLoader", () => {
  test("runs an input-only row as a single turn", () => {
    const [example] = DatasetLoader.load(JSON.stringify({ scenario_id: "s1", input: "Hi" }));

    expect(example).toBeInstanceOf(PredefinedExample);
    expect((example as PredefinedExample).turns).toEqual([{ input: "Hi" }]);
  });

  test("rejects a row with no turns, actor_profile or input", () => {
    expect(() => DatasetLoader.load(JSON.stringify({ scenario_id: "s1" }))).toThrow(
      InputValidationError,
    );
  });
});
