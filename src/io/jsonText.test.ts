import { describe, expect, test } from "bun:test";
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
});
