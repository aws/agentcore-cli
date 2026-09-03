import { describe, expect, test } from "bun:test";
import { TuiHandoffController } from "./handoff";

describe("TuiHandoffController", () => {
  test("stores one handoff and returns it exactly once", () => {
    const controller = new TuiHandoffController();
    const handoff = async () => {};

    controller.request(handoff);

    expect(controller.take()).toBe(handoff);
    expect(controller.take()).toBeUndefined();
  });

  test("rejects a second handoff request", () => {
    const controller = new TuiHandoffController();
    controller.request(async () => {});

    expect(() => controller.request(async () => {})).toThrow("TUI handoff already requested");
  });

  test("preserves the handoff result", async () => {
    const controller = new TuiHandoffController();
    controller.request(async () => ({ resumePath: "/agentcore/runtime/shell" }));

    await expect(controller.take()!({} as never)).resolves.toEqual({
      resumePath: "/agentcore/runtime/shell",
    });
  });
});
