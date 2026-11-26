import { describe, expect, test } from "bun:test";
import { boxGatewaySpec } from "../../../projectSchemas/project";
import { boundRuntimeNote, defaultGatewayChoice } from "./shared";

describe("gateway choices in the add wizards", () => {
  test("the default is the first unbound gateway, and else the first gateway", () => {
    const box = boxGatewaySpec("agent", "strands-box");
    expect(defaultGatewayChoice([box, { name: "tools" }])).toBe("tools");
    expect(defaultGatewayChoice([box])).toBe("agent-box-egress");
    expect(defaultGatewayChoice([])).toBe("");
  });

  test("only a bound gateway gets the bound-runtime note", () => {
    expect(boundRuntimeNote(boxGatewaySpec("agent", "strands-box"))).toBe(
      " · bound to runtime 'agent'",
    );
    expect(boundRuntimeNote({})).toBe("");
  });
});
