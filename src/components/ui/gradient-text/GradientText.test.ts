import { describe, expect, test } from "bun:test";
import { interpolateGradientColor } from "./GradientText";

describe("interpolateGradientColor", () => {
  test("returns the start, midpoint, and end colors", () => {
    const colors = ["#000000", "#ffffff"] as const;

    expect(interpolateGradientColor(colors, 0)).toBe("#000000");
    expect(interpolateGradientColor(colors, 0.5)).toBe("#808080");
    expect(interpolateGradientColor(colors, 1)).toBe("#ffffff");
  });
});
