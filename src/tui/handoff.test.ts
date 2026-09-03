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
});
