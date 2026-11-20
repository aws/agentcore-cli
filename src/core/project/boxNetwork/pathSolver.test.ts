import { describe, expect, test } from "bun:test";
import type { Comparison, FieldAtom } from "./conditions";
import type { LikePattern } from "./dogwood";
import { findPath, pathTest, type PathTest } from "./pathSolver";

/** A `like` pattern, with each `*` as a wildcard. */
function like(text: string): LikePattern {
  const parts: LikePattern["parts"][number][] = [];
  for (const [i, piece] of text.split("*").entries()) {
    if (i > 0) parts.push({ kind: "wildcard" });
    if (piece !== "") parts.push({ kind: "literal", text: piece });
  }
  return { parts };
}

const atom = (comparison: Comparison, negated = false): FieldAtom => ({
  kind: "field",
  field: "path",
  comparison,
  negated,
  text: "context.input.path",
});
const literal = (text: string): LikePattern => ({ parts: [{ kind: "literal", text }] });
const must = (text: string): PathTest => ({ pattern: like(text), matches: true });
const never = (text: string): PathTest => ({ pattern: like(text), matches: false });

describe("pathTest", () => {
  test.each<[string, FieldAtom, PathTest | boolean]>([
    ["like", atom({ op: "like", pattern: like("/v1/*") }), must("/v1/*")],
    ["!(like)", atom({ op: "like", pattern: like("/v1/*") }, true), never("/v1/*")],
    ["==", atom({ op: "==", value: "/a" }), { pattern: literal("/a"), matches: true }],
    ["!(==)", atom({ op: "==", value: "/a" }, true), { pattern: literal("/a"), matches: false }],
    ["!=", atom({ op: "!=", value: "/a" }), { pattern: literal("/a"), matches: false }],
    ["!(!=)", atom({ op: "!=", value: "/a" }, true), { pattern: literal("/a"), matches: true }],
    ["has", atom({ op: "present" }), true],
    ["!(has)", atom({ op: "present" }, true), false],
  ])("reads %s", (_, input, expected) => {
    expect(pathTest(input)).toEqual(expected);
  });
});

describe("findPath", () => {
  const filler = "§";
  const path = (required: PathTest[], excluded: PathTest[][] = []) => {
    const found = findPath(required, excluded, filler);
    return found.kind === "path" ? found.path : found.kind;
  };

  test("finds the shortest path that two patterns of a permit allow together", () => {
    expect(path([must("/v1/*"), must("*/items")])).toBe("/v1/items");
  });

  test("finds a path past a != in a permit", () => {
    const found = path([must("/a*"), { pattern: literal("/a"), matches: false }]);
    expect(found).not.toBe("/a");
    expect(found).toStartWith("/a");
  });

  test("finds a path past a negated like in a permit", () => {
    const found = path([must("/v1/*"), never("/v1/admin*"), never("/v1/")]);
    expect(found).toStartWith("/v1/");
    expect(found).not.toStartWith("/v1/admin");
    expect(found).not.toBe("/v1/");
  });

  test("finds a path that a forbid does not hold on, and none when every path is forbidden", () => {
    const found = path([must("/v1/*"), must("*/items")], [[must("/v1/items")]]);
    expect(found).toBe("/v1//items");
    expect(path([must("/v1/*")], [[must("/*")]])).toBe("none");
    expect(path([must("/*")], [[]])).toBe("none");
  });

  test("uses a character that no pattern names when the filler is in a pattern", () => {
    const found = path([must("/*"), never("/"), never("/§*"), never("//*")]);
    // U+E000, the first private-use character, which no pattern names.
    expect(found).toBe("/\uE000");
  });

  test("finds no path for patterns that never hold together", () => {
    expect(path([must("/v1/*"), must("/v2/*")])).toBe("none");
    expect(path([must("v1/*")])).toBe("none");
  });

  test("stops undecided when the search has too many states", () => {
    expect(path([..."abcdefghijklm"].map((c) => must(`*${c}*`)))).toBe("undecided");
  });
});
