import { afterEach, describe, expect, test } from "bun:test";
import {
  cleanupScreens,
  renderScreen,
  TestCoreClient,
  TestRuntimeClient,
  waitForText,
} from "../../testing";

afterEach(cleanupScreens);

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

  test("configures detail responses and records every method call", async () => {
    const runtime = new TestRuntimeClient();
    const options = { region: "us-west-2" };
    const getResponse = {
      agentRuntimeName: "latest",
    } as Awaited<ReturnType<TestRuntimeClient["getRuntime"]>>;
    const versionResponse = {
      agentRuntimeName: "version",
    } as Awaited<ReturnType<TestRuntimeClient["getRuntimeVersion"]>>;
    const endpointResponse = {
      endpointName: "prod",
    } as unknown as Awaited<ReturnType<TestRuntimeClient["getRuntimeEndpoint"]>>;

    expect(runtime.setGetResponse(getResponse)).toBe(runtime);
    expect(runtime.setGetVersionResponse(versionResponse)).toBe(runtime);
    expect(runtime.setGetEndpointResponse(endpointResponse)).toBe(runtime);

    expect(await runtime.getRuntime("runtime-1", options)).toBe(getResponse);
    expect(await runtime.getRuntimeVersion("runtime-1", "2", options)).toBe(versionResponse);
    expect(await runtime.getRuntimeEndpoint("runtime-1", "prod", options)).toBe(endpointResponse);

    expect(runtime.calls).toEqual([
      { method: "getRuntime", args: ["runtime-1", options] },
      { method: "getRuntimeVersion", args: ["runtime-1", "2", options] },
      { method: "getRuntimeEndpoint", args: ["runtime-1", "prod", options] },
    ]);
  });

  test("serves token-specific, first-page, and empty list responses", async () => {
    const runtime = new TestRuntimeClient();
    const options = { region: "us-east-1" };
    const runtimesFirst = { agentRuntimes: [], nextToken: "runtime-page-2" };
    const runtimesSecond = { agentRuntimes: [], nextToken: "runtime-page-3" };
    const versionsFirst = { agentRuntimes: [], nextToken: "version-page-2" };
    const versionsSecond = { agentRuntimes: [], nextToken: "version-page-3" };
    const endpointsFirst = { runtimeEndpoints: [], nextToken: "endpoint-page-2" };
    const endpointsSecond = { runtimeEndpoints: [], nextToken: "endpoint-page-3" };

    expect(runtime.setListResponse(runtimesFirst)).toBe(runtime);
    expect(runtime.setListResponse(runtimesSecond, "runtime-page-2")).toBe(runtime);
    expect(runtime.setListVersionsResponse(versionsFirst)).toBe(runtime);
    expect(runtime.setListVersionsResponse(versionsSecond, "version-page-2")).toBe(runtime);
    expect(runtime.setListEndpointsResponse(endpointsFirst)).toBe(runtime);
    expect(runtime.setListEndpointsResponse(endpointsSecond, "endpoint-page-2")).toBe(runtime);

    expect(await runtime.listRuntimes("runtime-page-2", 10, options)).toBe(runtimesSecond);
    expect(await runtime.listRuntimes("unknown", 10, options)).toBe(runtimesFirst);
    expect(await runtime.listRuntimeVersions("runtime-1", "version-page-2", 11, options)).toBe(
      versionsSecond,
    );
    expect(await runtime.listRuntimeVersions("runtime-1", "unknown", 11, options)).toBe(
      versionsFirst,
    );
    expect(await runtime.listRuntimeEndpoints("runtime-1", "endpoint-page-2", 12, options)).toBe(
      endpointsSecond,
    );
    expect(await runtime.listRuntimeEndpoints("runtime-1", "unknown", 12, options)).toBe(
      endpointsFirst,
    );

    const empty = new TestRuntimeClient();
    expect(await empty.listRuntimes(undefined, undefined, options)).toEqual({
      agentRuntimes: [],
    });
    expect(await empty.listRuntimeVersions("runtime-1", undefined, undefined, options)).toEqual({
      agentRuntimes: [],
    });
    expect(await empty.listRuntimeEndpoints("runtime-1", undefined, undefined, options)).toEqual({
      runtimeEndpoints: [],
    });

    expect(runtime.calls).toEqual([
      { method: "listRuntimes", args: ["runtime-page-2", 10, options] },
      { method: "listRuntimes", args: ["unknown", 10, options] },
      {
        method: "listRuntimeVersions",
        args: ["runtime-1", "version-page-2", 11, options],
      },
      { method: "listRuntimeVersions", args: ["runtime-1", "unknown", 11, options] },
      {
        method: "listRuntimeEndpoints",
        args: ["runtime-1", "endpoint-page-2", 12, options],
      },
      { method: "listRuntimeEndpoints", args: ["runtime-1", "unknown", 12, options] },
    ]);
  });

  test("records calls before throwing configured errors", async () => {
    const runtime = new TestRuntimeClient();
    const error = new Error("access denied");
    const options = { region: "us-east-1" };
    const response = {
      agentRuntimeName: "recovered",
    } as Awaited<ReturnType<TestRuntimeClient["getRuntime"]>>;

    runtime.setGetResponse(response);
    expect(runtime.setError(error)).toBe(runtime);
    await expect(runtime.getRuntime("runtime-1", options)).rejects.toBe(error);
    expect(runtime.calls).toEqual([{ method: "getRuntime", args: ["runtime-1", options] }]);

    expect(runtime.setError(undefined)).toBe(runtime);
    expect(await runtime.getRuntime("runtime-2", options)).toBe(response);
  });

  test("resizes the rendered terminal and defaults omitted rows to 40", async () => {
    const r = renderScreen("/agentcore/runtime");
    await waitForText(r.lastFrame, "agentcore → runtime");

    expect(
      Math.max(
        ...r
          .lastFrame()!
          .split("\n")
          .map((line) => line.length),
      ),
    ).toBe(100);

    await r.resize(60, 12);
    const compactLines = r.lastFrame()!.split("\n");
    expect(Math.max(...compactLines.map((line) => line.length))).toBe(60);
    expect(compactLines).toHaveLength(12);

    await r.resize(70);
    const defaultHeightLines = r.lastFrame()!.split("\n");
    expect(Math.max(...defaultHeightLines.map((line) => line.length))).toBe(70);
    expect(defaultHeightLines.length).toBeGreaterThan(12);
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
