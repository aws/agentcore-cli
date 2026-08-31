import { describe, expect, test } from "bun:test";
import { InputValidationError } from "../../errors";
import { parseTimeString, resolveTimeWindow } from "./time";

describe("parseTimeString", () => {
  const now = () => 1_700_000_000_000;

  test("parses relative, epoch, ISO, and now values", () => {
    expect(parseTimeString("30s", now)).toBe(1_699_999_970_000);
    expect(parseTimeString("5m", now)).toBe(1_699_999_700_000);
    expect(parseTimeString("1h", now)).toBe(1_699_996_400_000);
    expect(parseTimeString("2d", now)).toBe(1_699_827_200_000);
    expect(parseTimeString("1709391000000", now)).toBe(1_709_391_000_000);
    expect(parseTimeString("2026-03-02T14:30:00Z", now)).toBe(Date.parse("2026-03-02T14:30:00Z"));
    expect(parseTimeString("now", now)).toBe(1_700_000_000_000);
  });

  test("rejects empty and invalid values with typed guidance", () => {
    expect(() => parseTimeString(" ", now)).toThrow(InputValidationError);
    expect(() => parseTimeString("5x", now)).toThrow('Invalid time string: "5x"');
  });
});

describe("resolveTimeWindow", () => {
  test("derives the default start from a historical end", () => {
    expect(
      resolveTimeWindow(
        {
          until: "1709391000000",
          defaultWindowMs: 3_600_000,
        },
        () => 1_800_000_000_000,
      ),
    ).toEqual({
      startTimeMs: 1_709_387_400_000,
      endTimeMs: 1_709_391_000_000,
    });
  });

  test("rejects an inverted window", () => {
    expect(() =>
      resolveTimeWindow({
        since: "1709391000000",
        until: "1709381000000",
        defaultWindowMs: 3_600_000,
      }),
    ).toThrow("--since must resolve to a time before --until");
  });
});
