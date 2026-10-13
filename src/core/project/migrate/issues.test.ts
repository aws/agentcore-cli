import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { describePath, droppedPaths, problemsFromZodError } from "./issues";

describe("describePath", () => {
  const root = {
    credentials: [{ name: "key" }, { other: true }],
    gateways: [{ name: "gw", targets: [{ name: "t1", outboundAuth: {} }] }],
  };

  test("names array entries by their name field", () => {
    expect(describePath(root, ["credentials", 0, "name"])).toBe("credentials[key].name");
    expect(describePath(root, ["gateways", 0, "targets", 0, "outboundAuth"])).toBe(
      "gateways[gw].targets[t1].outboundAuth",
    );
  });

  test("falls back to the index for entries without a name", () => {
    expect(describePath(root, ["credentials", 1, "other"])).toBe("credentials[1].other");
  });

  test("describes the empty path as the top level", () => {
    expect(describePath(root, [])).toBe("(top level)");
  });
});

describe("problemsFromZodError", () => {
  test("turns each issue into a problem against the input", () => {
    const input = { items: [{ name: "a", size: "big" }] };
    const result = z
      .object({ items: z.array(z.object({ name: z.string(), size: z.number() })) })
      .safeParse(input);
    if (result.success) throw new Error("expected a failure");
    expect(problemsFromZodError("f.json", input, result.error)).toEqual([
      { file: "f.json", path: "items[a].size", message: expect.stringContaining("number") },
    ]);
  });
});

describe("droppedPaths", () => {
  test("finds keys the parse stripped, at any depth", () => {
    const before = { a: 1, list: [{ keep: 1, drop: 2 }], nested: { gone: true }, unset: undefined };
    const after = { a: 1, list: [{ keep: 1 }], nested: {} };
    expect(droppedPaths(before, after)).toEqual([
      ["list", 0, "drop"],
      ["nested", "gone"],
    ]);
  });

  test("reports nothing when nothing was stripped", () => {
    expect(droppedPaths({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }], extra: 3 })).toEqual([]);
  });
});
