import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { stringifyJson } from "./jsonText";

describe("stringifyJson", () => {
  test("returns JSON.stringify output for values without a BigInt", () => {
    const value = { a: 1, s: "bigint:34", n: [null, true] };
    expect(stringifyJson(value)).toBe(JSON.stringify(value));
    expect(stringifyJson(value, 2)).toBe(JSON.stringify(value, null, 2));
  });

  test("keeps real strings that contain the marker next to a BigInt", () => {
    expect(stringifyJson({ a: 12n, s: '"bigint:34"', t: "bigint:56", u: ["bigint:_78"] })).toBe(
      '{"a":12,"s":"\\"bigint:34\\"","t":"bigint:56","u":["bigint:_78"]}',
    );
  });

  test.each([undefined, 2])("preserves numeric strings and keys with spacing %s", (space) => {
    const value = {
      "9007199254740993": "9007199254740993",
      nested: ["before", 9007199254740993n, { "-12": -12n }, "after"],
      zero: 0n,
    };
    const expected = space
      ? '{\n  "9007199254740993": "9007199254740993",\n  "nested": [\n    "before",\n    9007199254740993,\n    {\n      "-12": -12\n    },\n    "after"\n  ],\n  "zero": 0\n}'
      : '{"9007199254740993":"9007199254740993","nested":["before",9007199254740993,{"-12":-12},"after"],"zero":0}';
    expect(stringifyJson(value, space)).toBe(expected);
  });

  test.each(['quote: " slash: \\ newline: \n colon: ":', "\\", "\u0000", "\ud800"])(
    "preserves escaped strings next to a BigInt: %s",
    (text) => {
      expect(stringifyJson([text, 12n])).toBe(`[${JSON.stringify(text)},12]`);
    },
  );

  test.each([
    [0n, "0"],
    [-12n, "-12"],
    [9007199254740993n, "9007199254740993"],
  ])("serializes a top-level BigInt %s", (value, expected) => {
    expect(stringifyJson(value)).toBe(expected);
  });

  test("evaluates getters and toJSON once", () => {
    let getterCalls = 0;
    let toJsonCalls = 0;
    const value = {
      ts: 1n,
      get text() {
        getterCalls++;
        return "12";
      },
      detail: {
        toJSON() {
          return ++toJsonCalls === 1 ? "first" : "bigint:123";
        },
      },
    };
    expect(stringifyJson(value)).toBe('{"ts":1,"text":"12","detail":"first"}');
    expect(getterCalls).toBe(1);
    expect(toJsonCalls).toBe(1);
  });

  test.each([
    new String("12"),
    runInNewContext('new String("12")') as unknown,
    { toJSON: () => new String("12") },
  ])("preserves boxed string values before a BigInt: %s", (text) => {
    expect(stringifyJson({ text, n: 12n })).toBe('{"text":"12","n":12}');
  });

  test("preserves raw JSON string values before a BigInt", () => {
    const json = JSON as typeof JSON & { rawJSON: (text: string) => unknown };
    expect(stringifyJson({ text: json.rawJSON('"12"'), n: 12n })).toBe('{"text":"12","n":12}');
  });

  test("preserves a long marker-like string next to a BigInt", () => {
    const text = `bigint:${"_".repeat(120_000)}`;
    expect(stringifyJson({ n: 12n, text })).toBe(`{"n":12,"text":${JSON.stringify(text)}}`);
  });

  test("retains native handling of dates and omitted values", () => {
    expect(
      stringifyJson({
        omitted: undefined,
        date: new Date("2026-01-01T00:00:00Z"),
        values: [undefined, () => {}, Symbol(), Infinity, 1n],
      }),
    ).toBe('{"date":"2026-01-01T00:00:00.000Z","values":[null,null,null,null,1]}');
  });

  test("retains native rejection of circular input", () => {
    const value: { n: bigint; self?: unknown } = { n: 1n };
    value.self = value;
    expect(() => stringifyJson(value)).toThrow(TypeError);
  });
});
