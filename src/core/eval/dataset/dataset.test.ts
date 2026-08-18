import { test, expect, describe } from "bun:test";
import { DatasetLoader } from "./load";
import { PredefinedExample } from "./predefined";
import { SimulatedExample } from "./simulated";
import type { RunContext, TurnResult } from "./types";

const row = (o: object) => JSON.stringify(o);

// A fake transport that records what was said and returns a canned reply. No AWS.
function recordingCtx(reply = ""): { ctx: RunContext; calls: string[] } {
  const calls: string[] = [];
  const ctx: RunContext = {
    invokeOnce: async (payload): Promise<TurnResult> => {
      calls.push(payload);
      return { text: reply };
    },
  };
  return { ctx, calls };
}

describe("DatasetLoader.load", () => {
  test("builds a PredefinedExample from a turns row", () => {
    const [e] = DatasetLoader.load(row({ example_id: "x", turns: [{ input: "hi" }] }));
    expect(e).toBeInstanceOf(PredefinedExample);
    expect(e!.schemaType).toBe("AGENTCORE_EVALUATION_PREDEFINED_V1");
    expect(e!.exampleId).toBe("x");
  });

  test("accepts the legacy scenario_id as the example id", () => {
    const [e] = DatasetLoader.load(row({ scenario_id: "legacy", turns: [{ input: "hi" }] }));
    expect(e!.exampleId).toBe("legacy");
  });

  test("refuses a row that is both predefined and simulated", () => {
    expect(() =>
      DatasetLoader.load(row({ example_id: "x", turns: [{ input: "a" }], actor_profile: {} })),
    ).toThrow(/both 'turns' and 'actor_profile'/);
  });

  test("refuses a row that is neither", () => {
    expect(() => DatasetLoader.load(row({ example_id: "x" }))).toThrow(
      /neither 'turns' nor 'actor_profile'/,
    );
  });

  test("names a simulated row instead of blaming the data", () => {
    expect(() =>
      DatasetLoader.load(row({ example_id: "x", actor_profile: { goal: "g" } })),
    ).toThrow(/simulated example/);
  });

  test("rejects duplicate example ids", () => {
    const two = [
      row({ example_id: "a", turns: [{ input: "1" }] }),
      row({ example_id: "a", turns: [{ input: "2" }] }),
    ].join("\n");
    expect(() => DatasetLoader.load(two)).toThrow(/duplicate example_id: "a"/);
  });

  test("rejects a missing example id", () => {
    expect(() => DatasetLoader.load(row({ turns: [{ input: "hi" }] }))).toThrow(
      /missing 'example_id'/,
    );
  });

  test("rejects an invalid JSON line", () => {
    expect(() => DatasetLoader.load("{not json")).toThrow(/not valid JSON/);
  });

  test("rejects an empty dataset", () => {
    expect(() => DatasetLoader.load("\n  \n")).toThrow(/no examples/);
  });

  test("ignores blank lines between rows", () => {
    const examples = DatasetLoader.load(
      [
        row({ example_id: "a", turns: [{ input: "1" }] }),
        "",
        row({ example_id: "b", turns: [{ input: "2" }] }),
      ].join("\n"),
    );
    expect(examples.map((e) => e.exampleId)).toEqual(["a", "b"]);
  });
});

describe("SimulatedExample", () => {
  test("construction throws NotImplementedError (never replayed)", () => {
    expect(() => new SimulatedExample("x", { actor_profile: {} })).toThrow(/cannot replay yet/);
  });
});

describe("PredefinedExample", () => {
  test("constructor rejects a row with no turns", () => {
    expect(() => new PredefinedExample("x", { turns: [] })).toThrow(/has no turns/);
  });

  test("run replays every turn in order, on one session", async () => {
    const { ctx, calls } = recordingCtx();
    await new PredefinedExample("x", { turns: [{ input: "a" }, { input: "b" }] }).run(ctx);
    expect(calls).toEqual(["a", "b"]);
  });

  test("sparse expectations keep their turn position", async () => {
    const { ctx } = recordingCtx();
    const gt = await new PredefinedExample("x", {
      turns: [{ input: "t1" }, { input: "t2" }, { input: "t3", expected_response: "42" }],
    }).run(ctx);
    // Not 1 — filtering the two expectation-less turns would renumber the rest and score
    // turn 3's "42" against turn 1.
    expect(gt!.turns).toHaveLength(3);
    expect(gt!.turns![2]!.expectedResponse).toEqual({ text: "42" });
    expect(gt!.turns![0]!.input).toEqual({ prompt: "t1" });
    expect(gt!.turns![0]!.expectedResponse).toBeUndefined();
  });

  test("an example with no ground truth returns undefined", async () => {
    const { ctx } = recordingCtx();
    const gt = await new PredefinedExample("x", { turns: [{ input: "t1" }] }).run(ctx);
    expect(gt).toBeUndefined();
  });

  // Golden: the full inline ground-truth shape for a representative example (assertions +
  // trajectory + sparse turns). Locks the exact wire shape handed to the grader so a
  // regression in the mapping is caught, not just its parts.
  test("ground truth maps to the expected inline shape [golden]", async () => {
    const { ctx } = recordingCtx();
    const gt = await new PredefinedExample("orders-1", {
      turns: [
        { input: "I want a refund" },
        { input: "order 123", expected_response: "Refund started" },
      ],
      assertions: ["stays polite", "does not promise a date"],
      expected_trajectory: ["refund_lookup", "refund_create"],
    }).run(ctx);
    expect(gt).toMatchSnapshot();
  });
});
