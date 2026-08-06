import { describe, expect, test } from "bun:test";
import { InputValidationError, MalformedServiceResponseError } from "../errors";
import {
  applyExampleIds,
  diffExamples,
  indexRemoteById,
  parseJsonl,
  stripExampleId,
} from "./datasetDiff";

const withId = (id: string, extra: Record<string, unknown> = {}) => ({
  exampleId: id,
  scenario_id: `s-${id}`,
  ...extra,
});

function jsonl(...rows: Record<string, unknown>[]): string {
  return `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

describe("parseJsonl", () => {
  test("parses one example per line and captures exampleId", () => {
    const parsed = parseJsonl(jsonl(withId("a"), { scenario_id: "new" }), "file-path");

    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.exampleId).toBe("a");
    expect(parsed[1]?.exampleId).toBeUndefined();
  });

  test("skips blank lines, including a trailing newline", () => {
    const parsed = parseJsonl(`${JSON.stringify(withId("a"))}\n\n  \n`, "file-path");

    expect(parsed).toHaveLength(1);
  });

  test("reports the offending line number and an excerpt", () => {
    const text = `${JSON.stringify(withId("a"))}\n{"scenario_id": "broken"\n`;

    expect(() => parseJsonl(text, "file-path")).toThrow(InputValidationError);
    expect(() => parseJsonl(text, "file-path")).toThrow(/line 2/);
    expect(() => parseJsonl(text, "file-path")).toThrow(/scenario_id/);
  });

  test.each([
    ["null", "null"],
    ["an array", "[]"],
    ["a string", '"value"'],
    ["a number", "42"],
    ["a boolean", "true"],
  ])("rejects %s as a dataset example", (_description, line) => {
    expect(() => parseJsonl(`${line}\n`, "file-path")).toThrow(InputValidationError);
    expect(() => parseJsonl(`${line}\n`, "file-path")).toThrow(/expected a JSON object/);
  });

  test.each([
    ["a number", 42],
    ["null", null],
    ["an empty string", ""],
    ["a blank string", "   "],
  ])("rejects %s exampleId", (_description, exampleId) => {
    expect(() => parseJsonl(jsonl({ exampleId, scenario_id: "x" }), "file-path")).toThrow(
      InputValidationError,
    );
    expect(() => parseJsonl(jsonl({ exampleId, scenario_id: "x" }), "file-path")).toThrow(
      /non-empty string/,
    );
  });
});

describe("indexRemoteById", () => {
  test("rejects a remote example without an id", () => {
    const remote = parseJsonl(jsonl({ scenario_id: "missing-id" }), "remote");

    expect(() => indexRemoteById(remote)).toThrow(MalformedServiceResponseError);
    expect(() => indexRemoteById(remote)).toThrow(/missing a valid exampleId/);
    try {
      indexRemoteById(remote);
    } catch (error) {
      expect(error).toMatchObject({ source: "service" });
    }
  });

  test("rejects duplicate remote ids instead of overwriting an example", () => {
    const remote = parseJsonl(jsonl(withId("duplicate"), withId("duplicate")), "remote");

    expect(() => indexRemoteById(remote)).toThrow(MalformedServiceResponseError);
    expect(() => indexRemoteById(remote)).toThrow(/duplicate exampleId "duplicate"/);
  });
});

describe("diffExamples", () => {
  test("classifies additions, updates, deletions, and unchanged rows", () => {
    const remote = indexRemoteById(
      parseJsonl(jsonl(withId("keep"), withId("change"), withId("gone")), "remote"),
    );
    const local = parseJsonl(
      jsonl(withId("keep"), withId("change", { note: "edited" }), { scenario_id: "brand-new" }),
      "file-path",
    );

    const diff = diffExamples(local, remote);

    expect(diff.unchanged).toBe(1);
    expect(diff.updates).toEqual([withId("change", { note: "edited" })]);
    expect(diff.deleteIds).toEqual(["gone"]);
    expect(diff.additions).toEqual([{ localIndex: 2, content: { scenario_id: "brand-new" } }]);
  });

  // The service does not preserve submitted key order, so a round-tripped example
  // must not read as modified.
  test("treats key reordering as unchanged", () => {
    const remote = indexRemoteById([
      {
        exampleId: "a",
        content: { exampleId: "a", alpha: 1, nested: { first: 1, second: 2 } },
      },
    ]);
    const local: Parameters<typeof diffExamples>[0] = [
      {
        exampleId: "a",
        content: { nested: { second: 2, first: 1 }, exampleId: "a", alpha: 1 },
      },
    ];

    const diff = diffExamples(local, remote);

    expect(diff.unchanged).toBe(1);
    expect(diff.updates).toEqual([]);
  });

  test("treats array reordering as an update", () => {
    const remote = indexRemoteById([
      { exampleId: "a", content: { exampleId: "a", values: [1, 2] } },
    ]);
    const local: Parameters<typeof diffExamples>[0] = [
      { exampleId: "a", content: { exampleId: "a", values: [2, 1] } },
    ];

    const diff = diffExamples(local, remote);

    expect(diff.unchanged).toBe(0);
    expect(diff.updates).toEqual([{ exampleId: "a", values: [2, 1] }]);
  });

  // An id absent remotely is stale (e.g. the dataset was recreated); re-adding is
  // recoverable, whereas failing would leave the file unusable.
  test("treats a stale exampleId as an addition and strips the id", () => {
    const local = parseJsonl(jsonl(withId("stale")), "file-path");

    const diff = diffExamples(local, new Map());

    expect(diff.additions).toEqual([{ localIndex: 0, content: { scenario_id: "s-stale" } }]);
    expect(diff.additions[0]?.content).not.toHaveProperty("exampleId");
  });

  test("deletes every remote row when the local file is empty", () => {
    const remote = indexRemoteById(parseJsonl(jsonl(withId("a"), withId("b")), "remote"));

    const diff = diffExamples([], remote);

    expect(diff.deleteIds).toEqual(["a", "b"]);
    expect(diff.additions).toEqual([]);
  });

  test("adds every row when the remote DRAFT is empty", () => {
    const local = parseJsonl(jsonl({ scenario_id: "a" }, { scenario_id: "b" }), "file-path");

    const diff = diffExamples(local, new Map());

    expect(diff.additions.map((a) => a.localIndex)).toEqual([0, 1]);
    expect(diff.deleteIds).toEqual([]);
  });

  test("rejects duplicate local ids before classifying either row", () => {
    const local = parseJsonl(
      jsonl(withId("duplicate"), withId("duplicate", { note: "different row" })),
      "file-path",
    );
    const remote = indexRemoteById(parseJsonl(jsonl(withId("duplicate")), "remote"));

    expect(() => diffExamples(local, remote)).toThrow(InputValidationError);
    expect(() => diffExamples(local, remote)).toThrow(/duplicate exampleId "duplicate"/);
  });
});

describe("applyExampleIds", () => {
  test("assigns ids positionally to added rows and leaves others untouched", () => {
    const local = parseJsonl(
      jsonl(withId("keep"), { scenario_id: "new-1" }, { scenario_id: "new-2" }),
      "file-path",
    );
    const diff = diffExamples(local, indexRemoteById(parseJsonl(jsonl(withId("keep")), "remote")));

    const rendered = applyExampleIds(local, diff.additions, ["id-1", "id-2"]);

    const rows = rendered
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(rows[0]?.exampleId).toBe("keep");
    expect(rows[1]).toEqual({ exampleId: "id-1", scenario_id: "new-1" });
    expect(rows[2]).toEqual({ exampleId: "id-2", scenario_id: "new-2" });
  });

  // Identical rows must each get their own id: keying on content would collapse
  // them onto one.
  test("assigns distinct ids to duplicate rows", () => {
    const local = parseJsonl(jsonl({ scenario_id: "dupe" }, { scenario_id: "dupe" }), "file-path");
    const diff = diffExamples(local, new Map());

    const rows = applyExampleIds(local, diff.additions, ["id-1", "id-2"])
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    expect(rows.map((r) => r.exampleId)).toEqual(["id-1", "id-2"]);
  });

  test("replaces a stale id with the newly assigned one", () => {
    const local = parseJsonl(jsonl(withId("stale")), "file-path");
    const diff = diffExamples(local, new Map());

    const rows = applyExampleIds(local, diff.additions, ["fresh"])
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    expect(rows[0]).toEqual({ exampleId: "fresh", scenario_id: "s-stale" });
  });

  test("ends the file with a trailing newline", () => {
    const local = parseJsonl(jsonl({ scenario_id: "a" }), "file-path");
    const diff = diffExamples(local, new Map());

    expect(applyExampleIds(local, diff.additions, ["id-1"]).endsWith("\n")).toBe(true);
  });

  test("renders an empty file when there are no rows", () => {
    expect(applyExampleIds([], [], [])).toBe("");
  });

  test.each([
    ["too few", ["id-1"]],
    ["too many", ["id-1", "id-2", "id-3"]],
  ])("rejects %s assigned ids", (_description, assignedIds) => {
    const local = parseJsonl(jsonl({ scenario_id: "one" }, { scenario_id: "two" }), "file-path");
    const additions = diffExamples(local, new Map()).additions;

    expect(() => applyExampleIds(local, additions, assignedIds)).toThrow(
      MalformedServiceResponseError,
    );
    expect(() => applyExampleIds(local, additions, assignedIds)).toThrow(
      /returned \d+ exampleIds for 2 additions/,
    );
  });

  test("rejects an empty assigned id", () => {
    const local = parseJsonl(jsonl({ scenario_id: "one" }), "file-path");
    const additions = diffExamples(local, new Map()).additions;

    expect(() => applyExampleIds(local, additions, [""])).toThrow(MalformedServiceResponseError);
    expect(() => applyExampleIds(local, additions, [""])).toThrow(/invalid exampleId/);
  });

  test("rejects duplicate assigned ids", () => {
    const local = parseJsonl(jsonl({ scenario_id: "one" }, { scenario_id: "two" }), "file-path");
    const additions = diffExamples(local, new Map()).additions;

    expect(() => applyExampleIds(local, additions, ["same-id", "same-id"])).toThrow(
      MalformedServiceResponseError,
    );
    expect(() => applyExampleIds(local, additions, ["same-id", "same-id"])).toThrow(
      /duplicate exampleId "same-id"/,
    );
  });
});

describe("stripExampleId", () => {
  test("removes only exampleId", () => {
    expect(stripExampleId({ exampleId: "a", scenario_id: "x" })).toEqual({ scenario_id: "x" });
  });
});
