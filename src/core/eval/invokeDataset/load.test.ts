import { describe, expect, test } from "bun:test";
import type { InlineGroundTruth } from "@aws-sdk/client-bedrock-agentcore";
import { DatasetLoader } from "./load";
import type { RunContext } from "./example/types";

const row = (o: object) => JSON.stringify(o);

// A stub transport: every turn "succeeds" without a network call, so run() returns the
// ground truth built purely from the row — which is the mapping under test.
const stubCtx: RunContext = { invokeOnce: async () => ({ text: "ok" }) };

async function groundTruthOf(jsonl: string): Promise<InlineGroundTruth | undefined> {
  const [example] = DatasetLoader.load(jsonl);
  return example!.run(stubCtx);
}

describe("DatasetLoader.load — parse + validation", () => {
  test.each<[string, string, RegExp]>([
    [
      "both turns and actor_profile",
      row({ example_id: "x", turns: [{ input: "a" }], actor_profile: {} }),
      /both 'turns' and 'actor_profile'/,
    ],
    [
      "neither turns nor actor_profile",
      row({ example_id: "x" }),
      /neither 'turns' nor 'actor_profile'/,
    ],
    [
      "simulated example not supported yet",
      row({ example_id: "x", actor_profile: { goal: "g" } }),
      /simulated example/,
    ],
    [
      "duplicate example ids",
      [
        row({ example_id: "a", turns: [{ input: "1" }] }),
        row({ example_id: "a", turns: [{ input: "2" }] }),
      ].join("\n"),
      /duplicate example_id: "a"/,
    ],
    ["missing example id", row({ turns: [{ input: "hi" }] }), /missing 'example_id'/],
    ["invalid JSON line", "{not json", /not valid JSON/],
    ["non-object row (null)", "null", /not a JSON object/],
    ["empty dataset", "\n  \n", /no examples/],
    ["empty turns array", row({ example_id: "x", turns: [] }), /has no turns/],
    ["non-object turn entry", row({ example_id: "x", turns: [null] }), /turn 1 is not an object/],
    [
      "non-array assertions",
      row({ example_id: "x", turns: [{ input: "a" }], assertions: "nope" }),
      /assertions must be an array of strings/,
    ],
    [
      "non-array expected_trajectory",
      row({ example_id: "x", turns: [{ input: "a" }], expected_trajectory: "nope" }),
      /expected_trajectory must be an array of strings/,
    ],
  ])("rejects and builds nothing: %s", (_name, jsonl, expected) => {
    expect(() => DatasetLoader.load(jsonl)).toThrow(expected);
  });

  test("tolerates blank lines and CRLF between rows, keeping every example", () => {
    const jsonl =
      row({ example_id: "a", turns: [{ input: "1" }] }) +
      "\r\n\r\n" +
      row({ example_id: "b", turns: [{ input: "2" }] }) +
      "\r\n";
    expect(DatasetLoader.load(jsonl).map((e) => e.exampleId)).toEqual(["a", "b"]);
  });

  test("falls back to scenario_id and preserves a unicode id", () => {
    const [example] = DatasetLoader.load(
      row({ scenario_id: "café-日本-🎉", turns: [{ input: "1" }] }),
    );
    expect(example!.exampleId).toBe("café-日本-🎉");
  });
});

// The row → InlineGroundTruth mapping, asserted explicitly per shape (hand-written, so a
// wrong mapping fails even on a first recording). run() is exercised with a stub transport.
describe("DatasetLoader ground-truth mapping", () => {
  test("single turn, no expectation → no ground truth", async () => {
    expect(
      await groundTruthOf(row({ example_id: "e1", turns: [{ input: "hi" }] })),
    ).toBeUndefined();
  });

  test("empty expected_response is treated as no expectation", async () => {
    expect(
      await groundTruthOf(
        row({ example_id: "e3", turns: [{ input: "t1", expected_response: "" }] }),
      ),
    ).toBeUndefined();
  });

  test("multi-turn: a sparse expected_response keeps its turn position", async () => {
    const gt = await groundTruthOf(
      row({
        example_id: "e2",
        turns: [{ input: "t1" }, { input: "t2" }, { input: "t3", expected_response: "42" }],
      }),
    );
    expect(gt).toEqual({
      turns: [
        { input: { prompt: "t1" } },
        { input: { prompt: "t2" } },
        { input: { prompt: "t3" }, expectedResponse: { text: "42" } },
      ],
    });
  });

  test("full inline shape: assertions + trajectory + sparse turns", async () => {
    const gt = await groundTruthOf(
      row({
        example_id: "orders-1",
        turns: [
          { input: "I want a refund" },
          { input: "order 123", expected_response: "Refund started" },
        ],
        assertions: ["stays polite", "does not promise a date"],
        expected_trajectory: ["refund_lookup", "refund_create"],
      }),
    );
    expect(gt).toEqual({
      assertions: [{ text: "stays polite" }, { text: "does not promise a date" }],
      expectedTrajectory: { toolNames: ["refund_lookup", "refund_create"] },
      turns: [
        { input: { prompt: "I want a refund" } },
        { input: { prompt: "order 123" }, expectedResponse: { text: "Refund started" } },
      ],
    });
  });

  test("empty assertions / expected_trajectory arrays are omitted", async () => {
    const gt = await groundTruthOf(
      row({
        example_id: "e4",
        turns: [{ input: "t1", expected_response: "r1" }],
        assertions: [],
        expected_trajectory: [],
      }),
    );
    expect(gt).toEqual({ turns: [{ input: { prompt: "t1" }, expectedResponse: { text: "r1" } }] });
  });
});
