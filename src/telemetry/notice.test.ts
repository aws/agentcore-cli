import { test, describe, expect } from "bun:test";
import { printFirstRunNotice } from "./notice";

describe("printFirstRunNotice", () => {
  test.each([
    [true, true, 1],
    [true, false, 0],
    [false, true, 0],
    [false, false, 0],
  ])(
    "isFirstRun=%p telemetryEnabled=%p writes the notice %p time(s)",
    (isFirstRun, telemetryEnabled, expectedWrites) => {
      const written: string[] = [];

      printFirstRunNotice(isFirstRun, telemetryEnabled, {
        write: (text) => void written.push(text),
      });

      expect(written).toHaveLength(expectedWrites);
      if (expectedWrites > 0) {
        expect(written[0]).toContain("collects aggregated, anonymous usage analytics");
        expect(written[0]).toContain("agentcore config telemetry.enabled false");
      }
    },
  );
});
