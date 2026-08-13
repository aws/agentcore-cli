import { describe, expect, it } from "bun:test";
import { TagKeySchema, TagsSchema } from "./tags";
describe("tag custom validation", () => {
  it("rejects whitespace-only and reserved keys", () => {
    expect(TagKeySchema.safeParse("   ").success).toBe(false);
    expect(TagKeySchema.safeParse("aws:owned").success).toBe(false);
  });
  it("enforces the AWS resource tag count", () => {
    const tags = Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`key${index}`, "v"]));
    expect(TagsSchema.safeParse(tags).success).toBe(false);
  });
});
