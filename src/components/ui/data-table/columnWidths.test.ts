import { describe, expect, test } from "bun:test";
import stringWidth from "string-width";
import { gatewayConnectorColumns } from "../../GatewayConnectorPicker";
import { gatewayColumns } from "../../GatewayPicker";
import { gatewayRuleColumns } from "../../GatewayRulePicker";
import { gatewayTargetColumns } from "../../GatewayTargetPicker";
import { harnessEndpointColumns } from "../../HarnessEndpointPicker";
import { harnessColumns } from "../../HarnessPicker";
import { harnessVersionColumns } from "../../HarnessVersionPicker";
import { runtimeEndpointColumns } from "../../RuntimeEndpointPicker";
import { runtimeColumns } from "../../RuntimePicker";
import { runtimeVersionColumns } from "../../RuntimeVersionPicker";
import {
  computeColumnWidths,
  FLEX_MAX_WIDTH,
  FLEX_MIN_WIDTH,
  resolveBorderWidth,
  SELECTION_MARKER_WIDTH,
} from "./columnWidths";
import { memoryColumns } from "../../MemoryPicker";

const widths = [40, 60, 80, 100, 120, 160, 200];
const flexConfigs = [
  { name: "Gateway", columns: gatewayColumns, flexIndex: 0 },
  { name: "Gateway Target", columns: gatewayTargetColumns, flexIndex: 0 },
  { name: "Gateway Connector", columns: gatewayConnectorColumns, flexIndex: 0 },
  { name: "Gateway Rule", columns: gatewayRuleColumns, flexIndex: 2 },
  { name: "Runtime", columns: runtimeColumns, flexIndex: 0 },
  { name: "Harness", columns: harnessColumns, flexIndex: 0 },
  { name: "Harness endpoint", columns: harnessEndpointColumns, flexIndex: 0 },
  { name: "Runtime endpoint", columns: runtimeEndpointColumns, flexIndex: 0 },
  { name: "Runtime version", columns: runtimeVersionColumns, flexIndex: 0 },
  { name: "Harness version", columns: harnessVersionColumns, flexIndex: 0 },
  { name: "Memory", columns: memoryColumns, flexIndex: 0 },
] as const;

describe("computeColumnWidths", () => {
  for (const config of flexConfigs) {
    test(`${config.name} fills supported terminal widths without overflow`, () => {
      for (const terminalWidth of widths) {
        const result = computeColumnWidths(config.columns, terminalWidth, {
          selectable: true,
          borderWidth: 0,
        });
        const flexWidth = result.widths[config.flexIndex]!;

        expect(result.totalWidth).toBeLessThanOrEqual(terminalWidth);
        expect(flexWidth).toBeGreaterThanOrEqual(FLEX_MIN_WIDTH);
        expect(flexWidth).toBeLessThanOrEqual(FLEX_MAX_WIDTH);
        // The table only stops short of the terminal edge once the flexible
        // column has hit its ceiling; the remainder is deliberate right margin.
        if (result.totalWidth !== terminalWidth) expect(flexWidth).toBe(FLEX_MAX_WIDTH);
      }
    });
  }

  test("drops fixed columns from right to left without truncating headers", () => {
    expect(computeColumnWidths(runtimeColumns, 40, { selectable: true, borderWidth: 0 })).toEqual({
      widths: [30, 7, undefined, undefined],
      totalWidth: 40,
    });
    expect(computeColumnWidths(runtimeColumns, 60, { selectable: true, borderWidth: 0 })).toEqual({
      widths: [29, 7, 20, undefined],
      totalWidth: 60,
    });
    expect(computeColumnWidths(runtimeColumns, 80, { selectable: true, borderWidth: 0 })).toEqual({
      widths: [32, 7, 20, 16],
      totalWidth: 80,
    });
  });

  test("caps the flexible column and leaves the leftover as right margin", () => {
    for (const terminalWidth of [100, 160, 200]) {
      expect(
        computeColumnWidths(runtimeColumns, terminalWidth, { selectable: true, borderWidth: 0 }),
      ).toEqual({ widths: [FLEX_MAX_WIDTH, 7, 20, 16], totalWidth: 88 });
    }
  });

  test("honors a per-column flex ceiling below the shared default", () => {
    const columns = [{ flex: true as const, maxWidth: 24 }, { width: 6 }];

    expect(computeColumnWidths(columns, 200, { selectable: false, borderWidth: 0 })).toEqual({
      widths: [24, 6],
      totalWidth: 31,
    });
  });

  test("defaults minWidth to width and honors explicit shrink floors", () => {
    const columns = [{ width: 6 }, { width: 6, minWidth: 4 }];

    expect(computeColumnWidths(columns, 11, { selectable: false, borderWidth: 0 })).toEqual({
      widths: [6, 4],
      totalWidth: 11,
    });
    expect(computeColumnWidths(columns, 10, { selectable: false, borderWidth: 0 })).toEqual({
      widths: [6, undefined],
      totalWidth: 6,
    });
  });

  test("keeps every visible production header intact", () => {
    for (const config of flexConfigs) {
      for (let terminalWidth = 1; terminalWidth <= 200; terminalWidth += 1) {
        const result = computeColumnWidths(config.columns, terminalWidth, {
          selectable: true,
          borderWidth: 0,
        });

        config.columns.forEach((column, index) => {
          const width = result.widths[index];
          if (width !== undefined) expect(width).toBeGreaterThanOrEqual(stringWidth(column.header));
        });
      }
    }
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

    expect(runtime.widths[1]).toBe(7);
    expect(harness.widths[1]).toBe(7);
    expect(endpoint.widths[1]).toBe(6);
    expect(endpoint.widths[2]).toBe(6);
  });

  test("terminates and respects the documented narrow-terminal bound", () => {
    for (const config of flexConfigs) {
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
    const result = computeColumnWidths([{ width: 6 }], 1, {
      selectable: true,
      borderWidth: 0,
    });

    expect(result.widths).toEqual([undefined]);
    expect(result.totalWidth).toBe(SELECTION_MARKER_WIDTH);
  });

  test("accounts for resolved borders", () => {
    const borderWidth = resolveBorderWidth({ style: "single" });
    const result = computeColumnWidths(runtimeColumns, 80, {
      selectable: true,
      borderWidth,
    });

    expect(borderWidth).toBe(2);
    expect(result.totalWidth + borderWidth).toBe(80);
    expect(resolveBorderWidth({ style: "single", left: false })).toBe(1);
    expect(resolveBorderWidth({ style: "single", left: false, right: false })).toBe(0);
    expect(resolveBorderWidth({})).toBe(0);
  });
});
