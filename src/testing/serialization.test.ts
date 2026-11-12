import { test, expect } from "bun:test";
import { parse, stringify } from "./serialization";

test("round-trips plain JSON values unchanged", () => {
  const value = { name: "harness", count: 3, nested: { ok: true }, list: [1, "two", null] };
  expect(parse<typeof value>(stringify(value))).toEqual(value);
});

test("revives Date values as real Date instances", () => {
  const date = new Date("2026-04-22T21:53:06.235Z");
  const revived = parse<{ createdAt: Date }>(stringify({ createdAt: date }));

  expect(revived.createdAt).toBeInstanceOf(Date);
  expect(revived.createdAt.toISOString()).toBe(date.toISOString());
});

test("revives Dates nested inside arrays and objects", () => {
  const value = {
    harnesses: [{ updatedAt: new Date("2026-01-02T03:04:05.000Z") }],
  };
  const revived = parse<typeof value>(stringify(value));

  expect(revived.harnesses[0]!.updatedAt).toBeInstanceOf(Date);
  expect(revived.harnesses[0]!.updatedAt.toISOString()).toBe("2026-01-02T03:04:05.000Z");
});

test("revives BigInt values as BigInt with every digit", () => {
  const value = { spans: [{ startTimeUnixNano: 1750000000000000001n }] };
  const revived = parse<typeof value>(stringify(value));
  expect(revived.spans[0]!.startTimeUnixNano).toBe(1750000000000000001n);
});

test("stringify produces indented, human-readable JSON", () => {
  expect(stringify({ a: 1 })).toBe('{\n  "a": 1\n}');
});
