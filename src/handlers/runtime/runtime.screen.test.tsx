import { afterEach, describe, expect, test } from "bun:test";
import { cleanupScreens, renderScreen, TestCoreClient, tick, waitForText } from "../../testing";

afterEach(cleanupScreens);

function frameSize(frame: string): { columns: number; rows: number } {
  const lines = frame.split("\n");
  return {
    columns: Math.max(...lines.map((line) => line.length)),
    rows: lines.length,
  };
}

describe("runtime test client", () => {
  test("configures list responses and records calls", async () => {
    const core = new TestCoreClient();
    core.runtime.setListResponse({ agentRuntimes: [], nextToken: "page-2" });

    await core.runtime.listRuntimes(undefined, 20, { region: "us-east-1" });

    expect(core.runtime.calls).toEqual([
      {
        method: "listRuntimes",
        args: [undefined, 20, { region: "us-east-1" }],
      },
    ]);
  });

  test("uses exact initial, explicit, and default resize dimensions", async () => {
    const r = renderScreen("/agentcore/runtime");
    await waitForText(r.lastFrame, "agentcore → runtime");
    await tick();

    expect(frameSize(r.lastFrame()!)).toEqual({ columns: 100, rows: 40 });

    await r.resize(60, 12);
    expect(frameSize(r.lastFrame()!)).toEqual({ columns: 60, rows: 12 });

    await r.resize(70);
    expect(frameSize(r.lastFrame()!)).toEqual({ columns: 70, rows: 40 });
  });
});

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
