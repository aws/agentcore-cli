import { describe, expect, test } from "bun:test";
import { shouldHideBrandBanner } from "./BrandBanner";

describe("BrandBanner", () => {
  test("hides the banner only in Apple Terminal", () => {
    expect(shouldHideBrandBanner("Apple_Terminal")).toBe(true);
    expect(shouldHideBrandBanner("iTerm.app")).toBe(false);
    expect(shouldHideBrandBanner("vscode")).toBe(false);
    expect(shouldHideBrandBanner(undefined)).toBe(false);
  });
});
