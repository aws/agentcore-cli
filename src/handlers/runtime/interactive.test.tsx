import { describe, expect, test } from "bun:test";
import { runtimeTuiPath } from "./interactive";

describe("runtimeTuiPath", () => {
  test.each([
    ["/agentcore/runtime", {}, "/agentcore/runtime"],
    ["/agentcore/runtime/version", {}, "/agentcore/runtime/version"],
    ["/agentcore/runtime/endpoint", {}, "/agentcore/runtime/endpoint"],
    ["/agentcore/runtime/get", {}, "/agentcore/runtime/list"],
    [
      "/agentcore/runtime/get",
      { id: "runtime/id with spaces" },
      "/agentcore/runtime/get/runtime%2Fid%20with%20spaces",
    ],
    ["/agentcore/runtime/list", {}, "/agentcore/runtime/list"],
    ["/agentcore/runtime/version/list", {}, "/agentcore/runtime/version/list"],
    [
      "/agentcore/runtime/version/list",
      { id: "runtime/id with spaces" },
      "/agentcore/runtime/version/list/runtime%2Fid%20with%20spaces",
    ],
    ["/agentcore/runtime/version/get", {}, "/agentcore/runtime/version/list"],
    [
      "/agentcore/runtime/version/get",
      { id: "runtime/id with spaces" },
      "/agentcore/runtime/version/list/runtime%2Fid%20with%20spaces",
    ],
    [
      "/agentcore/runtime/version/get",
      { id: "runtime/id with spaces", version: "v/1 + beta" },
      "/agentcore/runtime/version/get/runtime%2Fid%20with%20spaces/v%2F1%20%2B%20beta",
    ],
    ["/agentcore/runtime/endpoint/list", {}, "/agentcore/runtime/endpoint/list"],
    [
      "/agentcore/runtime/endpoint/list",
      { id: "runtime/id with spaces" },
      "/agentcore/runtime/endpoint/list/runtime%2Fid%20with%20spaces",
    ],
    ["/agentcore/runtime/endpoint/get", {}, "/agentcore/runtime/endpoint/list"],
    [
      "/agentcore/runtime/endpoint/get",
      { id: "runtime/id with spaces" },
      "/agentcore/runtime/endpoint/list/runtime%2Fid%20with%20spaces",
    ],
    [
      "/agentcore/runtime/endpoint/get",
      { id: "runtime/id with spaces", qualifier: "prod/us east" },
      "/agentcore/runtime/endpoint/get/runtime%2Fid%20with%20spaces/prod%2Fus%20east",
    ],
  ] as const)("maps %s", (commandPath, flags, expected) => {
    expect(runtimeTuiPath(commandPath, flags)).toBe(expected);
  });

  test("ignores empty and non-string selectors", () => {
    expect(runtimeTuiPath("/agentcore/runtime/get", { id: "" })).toBe("/agentcore/runtime/list");
    expect(runtimeTuiPath("/agentcore/runtime/get", { id: 42 })).toBe("/agentcore/runtime/list");
  });

  test("rejects a version without a Runtime ID", () => {
    expect(() => runtimeTuiPath("/agentcore/runtime/version/get", { version: "1" })).toThrow(
      /version.*id/i,
    );
  });

  test("rejects a qualifier without a Runtime ID", () => {
    expect(() => runtimeTuiPath("/agentcore/runtime/endpoint/get", { qualifier: "prod" })).toThrow(
      /qualifier.*id/i,
    );
  });

  test("rejects unknown command paths", () => {
    expect(() => runtimeTuiPath("/agentcore/runtime/unknown", {})).toThrow(
      /unknown Runtime command path/,
    );
  });
});
