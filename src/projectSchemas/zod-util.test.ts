import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { uniqueBy } from "./zod-util";
describe("uniqueBy", () => {
  const uniqueNames = uniqueBy<{ name: string }>(
    (item) => item.name,
    (name) => `Duplicate: ${name}`,
  );

  it("reports each duplicate at its array index without flagging the first occurrence", () => {
    const schema = z.array(z.object({ name: z.string() })).superRefine(uniqueNames);
    const result = schema.safeParse([{ name: "same" }, { name: "same" }, { name: "same" }]);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path)).toEqual([[1], [2]]);
    }
  });

  it("ignores an absent optional array", () => {
    const schema = z
      .array(z.object({ name: z.string() }))
      .optional()
      .superRefine(uniqueNames);

    expect(schema.safeParse(undefined).success).toBe(true);
  });
});
