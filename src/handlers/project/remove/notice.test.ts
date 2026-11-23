import { describe, expect, test } from "bun:test";
import { boundGatewayLines } from "./notice";

describe("boundGatewayLines", () => {
  test("names each gateway bound to the runtime and its targets before the removal", () => {
    const target = (name: string) => ({ name });
    const gateways = [
      { name: "none", boundRuntime: "agent", targets: [] },
      { name: "one", boundRuntime: "agent", targets: [target("search")] },
      { name: "two", boundRuntime: "agent", targets: [target("search"), target("docs")] },
      { name: "other", boundRuntime: "checkout", targets: [target("search")] },
      { name: "tools", targets: [target("search")] },
    ];

    expect(boundGatewayLines("agent", gateways)).toEqual([
      "gateway 'none'",
      "gateway 'one' and its target 'search'",
      "gateway 'two' and its targets 'search', 'docs'",
    ]);
  });

  test("names each removed gateway and its target count after the removal", () => {
    const removed = [
      { name: "none", targetCount: 0 },
      { name: "one", targetCount: 1 },
      { name: "three", targetCount: 3 },
    ];

    expect(boundGatewayLines("agent", removed)).toEqual([
      "removed gateway 'none': it is bound to runtime 'agent'",
      "removed gateway 'one' and its 1 target: it is bound to runtime 'agent'",
      "removed gateway 'three' and its 3 targets: it is bound to runtime 'agent'",
    ]);
  });
});
