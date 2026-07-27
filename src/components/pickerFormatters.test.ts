import { describe, expect, test } from "bun:test";
import { formatTimestamp, runtimeIdSuffix } from "./pickerFormatters";

describe("picker formatters", () => {
  test("formats valid timestamps as compact UTC values", () => {
    expect(formatTimestamp("2026-04-22T21:53:27.062Z")).toBe("2026-04-22 21:53");
    expect(formatTimestamp("2026-04-22T14:53:27.062-07:00")).toBe("2026-04-22 21:53");
  });

  test("renders invalid timestamps as blank values", () => {
    for (const value of [undefined, null, "", "garbage"]) {
      expect(formatTimestamp(value)).toBe("");
    }
  });

  test("extracts the discriminating Runtime id suffix", () => {
    expect(runtimeIdSuffix("orders-AbCdEf1234")).toBe("AbCdEf1234");
    expect(runtimeIdSuffix("legacy-id")).toBe("id");
    expect(runtimeIdSuffix("legacy")).toBe("legacy");
  });
});
