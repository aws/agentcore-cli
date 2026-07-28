import { describe, expect, test } from "bun:test";
import { harnessEndpointColumns } from "../../HarnessEndpointPicker";
import { harnessColumns } from "../../HarnessPicker";
import { harnessVersionColumns } from "../../HarnessVersionPicker";
import { runtimeEndpointColumns } from "../../RuntimeEndpointPicker";
import { runtimeColumns } from "../../RuntimePicker";
import { runtimeVersionColumns } from "../../RuntimeVersionPicker";
import {
  computeColumnWidths,
  FLEX_MIN_WIDTH,
  resolveBorderWidth,
  SELECTION_MARKER_WIDTH,
} from "./columnWidths";

const widths = [40, 60, 80, 100, 120, 160, 200];
const flexConfigs = [
  { name: "Runtime", columns: runtimeColumns, flexIndex: 0 },
  { name: "Harness", columns: harnessColumns, flexIndex: 0 },
  { name: "Harness endpoint", columns: harnessEndpointColumns, flexIndex: 0 },
  { name: "Runtime endpoint", columns: runtimeEndpointColumns, flexIndex: 0 },
] as const;
const fixedConfigs = [
  { name: "Runtime version", columns: runtimeVersionColumns },
  { name: "Harness version", columns: harnessVersionColumns },
] as const;

describe("computeColumnWidths", () => {
  for (const config of flexConfigs) {
    test(`${config.name} fills supported terminal widths without overflow`, () => {
      for (const terminalWidth of widths) {
        const result = computeColumnWidths(config.columns, terminalWidth, {
          selectable: true,
          borderWidth: 0,
        });

        expect(result.totalWidth).toBe(terminalWidth);
        expect(result.widths[config.flexIndex]!).toBeGreaterThanOrEqual(FLEX_MIN_WIDTH);
      }
    });
  }

  for (const config of fixedConfigs) {
    test(`${config.name} remains content-sized when space is available`, () => {
      for (const terminalWidth of widths) {
        const result = computeColumnWidths(config.columns, terminalWidth, {
          selectable: true,
          borderWidth: 0,
        });

        expect(result.totalWidth).toBe(40);
        expect(result.totalWidth).toBeLessThanOrEqual(terminalWidth);
        expect(result.widths.every((width) => width !== undefined)).toBe(true);
      }
    });
  }

  test("shrinks and drops fixed columns from right to left", () => {
    expect(computeColumnWidths(runtimeColumns, 40, { selectable: true, borderWidth: 0 })).toEqual({
      widths: [23, 10, 3, undefined, undefined],
      totalWidth: 40,
    });
    expect(computeColumnWidths(runtimeColumns, 60, { selectable: true, borderWidth: 0 })).toEqual({
      widths: [29, 10, 3, 13, undefined],
      totalWidth: 60,
    });
    expect(computeColumnWidths(runtimeColumns, 80, { selectable: true, borderWidth: 0 })).toEqual({
      widths: [30, 10, 5, 13, 16],
      totalWidth: 80,
    });
  });

  test("preserves all legal version digits at normal terminal widths", () => {
    const runtime = computeColumnWidths(runtimeColumns, 80, {
      selectable: true,
      borderWidth: 0,
    });
    const harness = computeColumnWidths(harnessColumns, 80, {
      selectable: true,
      borderWidth: 0,
    });
    const endpoint = computeColumnWidths(runtimeEndpointColumns, 80, {
      selectable: true,
      borderWidth: 0,
    });

    expect(runtime.widths[2]).toBe(5);
    expect(harness.widths[1]).toBe(5);
    expect(endpoint.widths[1]).toBe(6);
    expect(endpoint.widths[2]).toBe(6);
  });

  test("terminates and respects the documented narrow-terminal bound", () => {
    for (const config of [...flexConfigs, ...fixedConfigs]) {
      const hasFlex = config.columns.some((column) => "flex" in column && column.flex === true);
      for (let terminalWidth = 1; terminalWidth <= 20; terminalWidth += 1) {
        const result = computeColumnWidths(config.columns, terminalWidth, {
          selectable: true,
          borderWidth: 0,
        });
        const bound = hasFlex
          ? Math.max(terminalWidth, SELECTION_MARKER_WIDTH + 1 + FLEX_MIN_WIDTH)
          : terminalWidth;

        expect(result.totalWidth).toBeLessThanOrEqual(bound);
      }
    }
  });

  test("does not reserve a phantom gap after every data column drops", () => {
    const result = computeColumnWidths(runtimeVersionColumns, 1, {
      selectable: true,
      borderWidth: 0,
    });

    expect(result.widths).toEqual([undefined, undefined, undefined]);
    expect(result.totalWidth).toBe(SELECTION_MARKER_WIDTH);
  });

  test("accounts for resolved borders", () => {
    const borderWidth = resolveBorderWidth("single", undefined, undefined);
    const result = computeColumnWidths(runtimeColumns, 80, {
      selectable: true,
      borderWidth,
    });

    expect(borderWidth).toBe(2);
    expect(result.totalWidth + borderWidth).toBe(80);
    expect(resolveBorderWidth("single", false, undefined)).toBe(1);
    expect(resolveBorderWidth("single", false, false)).toBe(0);
    expect(resolveBorderWidth(undefined, undefined, undefined)).toBe(0);
  });
});
