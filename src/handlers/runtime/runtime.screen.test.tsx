import { afterEach, describe, expect, test } from "bun:test";
import { cleanupScreens, renderScreen, waitForText } from "../../testing";

afterEach(cleanupScreens);

describe("runtime menus", () => {
  test("renders the Runtime command menu", async () => {
    const r = renderScreen("/agentcore/runtime");
    await waitForText(r.lastFrame, "agentcore → runtime");

    const frame = r.lastFrame()!;
    for (const command of ["get", "list", "version", "endpoint"]) {
      expect(frame).toContain(command);
    }
  });

  test("renders the Runtime version command menu", async () => {
    const r = renderScreen("/agentcore/runtime/version");
    await waitForText(r.lastFrame, "agentcore → runtime → version");

    const frame = r.lastFrame()!;
    for (const command of ["get", "list"]) {
      expect(frame).toContain(command);
    }
  });

  test("renders the Runtime endpoint command menu", async () => {
    const r = renderScreen("/agentcore/runtime/endpoint");
    await waitForText(r.lastFrame, "agentcore → runtime → endpoint");

    const frame = r.lastFrame()!;
    for (const command of ["get", "list"]) {
      expect(frame).toContain(command);
    }
  });
});
