import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type {
  GetAgentRuntimeEndpointResponse,
  GetAgentRuntimeResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { CoreClient } from "../../core";
import {
  createSilentLogger,
  fixtureFactories,
  matchGolden,
  TestCoreClient,
  TestRuntimeClient,
  testIO,
} from "../../testing";
import { createRootHandler } from "../index";

const REGION = "us-west-2";
const FIXTURES = join(import.meta.dir, "__fixtures__");
const RUNTIME_ID = "runtime-1234567890";
const LONG_RUNTIME_ID = `${"a".repeat(48)}-1234567890`;

function configureRuntime(runtime: TestRuntimeClient): void {
  runtime
    .setGetResponse({
      agentRuntimeId: "runtime-1",
      agentRuntimeVersion: "1",
      status: "READY",
    } as GetAgentRuntimeResponse)
    .setGetVersionResponse({
      agentRuntimeId: "runtime-1",
      agentRuntimeVersion: "3",
      status: "READY",
    } as GetAgentRuntimeResponse)
    .setGetEndpointResponse({
      agentRuntimeArn: "arn:runtime-1",
      name: "PROD",
      status: "READY",
    } as GetAgentRuntimeEndpointResponse)
    .setListResponse({ agentRuntimes: [], nextToken: "runtime-token" })
    .setListVersionsResponse({ agentRuntimes: [], nextToken: "version-token" })
    .setListEndpointsResponse({ runtimeEndpoints: [], nextToken: "endpoint-token" });
}

async function run(
  args: string[],
  configure?: (runtime: TestRuntimeClient) => void,
): Promise<{
  stdout: string;
  runtime: TestRuntimeClient;
}> {
  const core = new TestCoreClient();
  configureRuntime(core.runtime);
  configure?.(core.runtime);
  const io = testIO();
  const root = createRootHandler(core, { io: io.io, logger: createSilentLogger() });

  await root.route(["node", "agentcore", ...args, "--region", REGION]);
  return { stdout: io.stdout(), runtime: core.runtime };
}

async function runFixture(args: string[]): Promise<string> {
  const { createControlClient, createDataClient, createIamClient } = fixtureFactories(FIXTURES);
  const core = new CoreClient(createControlClient, createDataClient, createIamClient);
  const io = testIO();
  const root = createRootHandler(core, { io: io.io, logger: createSilentLogger() });

  await root.route(["node", "agentcore", ...args, "--region", REGION]);
  return io.stdout();
}

describe("runtime command hierarchy", () => {
  test("registers only the approved control-plane branches", () => {
    const core = new TestCoreClient();
    const root = createRootHandler(core, {
      io: testIO().io,
      logger: createSilentLogger(),
    });
    const runtime = root.children().find((child) => child.name() === "runtime");

    expect(runtime?.children().map((child) => child.name())).toEqual([
      "get",
      "list",
      "version",
      "endpoint",
    ]);
    expect(
      runtime
        ?.children()
        .find((child) => child.name() === "version")
        ?.children()
        .map((child) => child.name()),
    ).toEqual(["get", "list"]);
    expect(
      runtime
        ?.children()
        .find((child) => child.name() === "endpoint")
        ?.children()
        .map((child) => child.name()),
    ).toEqual(["get", "list"]);
  });

  test.each(["runtime", "runtime version", "runtime endpoint"])(
    "prints AppIO-backed help for bare `%s` without a Core call",
    async (command) => {
      const result = await run(command.split(" "));

      expect(result.stdout).toContain(`Usage: agentcore ${command}`);
      expect(result.stdout).toContain("Commands:");
      expect(result.runtime.calls).toEqual([]);
    },
  );
});

describe("runtime control reads", () => {
  test("gets a Runtime and renders the complete response", async () => {
    const result = await run(["runtime", "get", "--id", "runtime-1"]);

    expect(JSON.parse(result.stdout)).toEqual({
      agentRuntimeId: "runtime-1",
      agentRuntimeVersion: "1",
      status: "READY",
    });
    expect(result.runtime.calls).toEqual([
      {
        method: "getRuntime",
        args: ["runtime-1", { region: REGION }],
      },
    ]);
  });

  test("lists one Runtime page with Harness pagination names", async () => {
    const result = await run([
      "runtime",
      "list",
      "--max-results",
      "5",
      "--next-token",
      "input-token",
    ]);

    expect(JSON.parse(result.stdout).nextToken).toBe("runtime-token");
    expect(result.runtime.calls).toEqual([
      {
        method: "listRuntimes",
        args: ["input-token", 5, { region: REGION }],
      },
    ]);
  });

  test("gets a Runtime version", async () => {
    const result = await run(["runtime", "version", "get", "--id", "runtime-1", "--version", "3"]);

    expect(JSON.parse(result.stdout).agentRuntimeVersion).toBe("3");
    expect(result.runtime.calls).toEqual([
      {
        method: "getRuntimeVersion",
        args: ["runtime-1", "3", { region: REGION }],
      },
    ]);
  });

  test("lists one Runtime version page", async () => {
    const result = await run([
      "runtime",
      "version",
      "list",
      "--id",
      "runtime-1",
      "--max-results",
      "7",
      "--next-token",
      "input-token",
    ]);

    expect(JSON.parse(result.stdout).nextToken).toBe("version-token");
    expect(result.runtime.calls).toEqual([
      {
        method: "listRuntimeVersions",
        args: ["runtime-1", "input-token", 7, { region: REGION }],
      },
    ]);
  });

  test("maps the endpoint qualifier", async () => {
    const result = await run([
      "runtime",
      "endpoint",
      "get",
      "--id",
      "runtime-1",
      "--qualifier",
      "PROD",
    ]);

    expect(JSON.parse(result.stdout).name).toBe("PROD");
    expect(result.runtime.calls).toEqual([
      {
        method: "getRuntimeEndpoint",
        args: ["runtime-1", "PROD", { region: REGION }],
      },
    ]);
  });

  test("lists one Runtime endpoint page", async () => {
    const result = await run([
      "runtime",
      "endpoint",
      "list",
      "--id",
      "runtime-1",
      "--max-results",
      "9",
      "--next-token",
      "input-token",
    ]);

    expect(JSON.parse(result.stdout).nextToken).toBe("endpoint-token");
    expect(result.runtime.calls).toEqual([
      {
        method: "listRuntimeEndpoints",
        args: ["runtime-1", "input-token", 9, { region: REGION }],
      },
    ]);
  });

  test.each([
    [["runtime", "get"], /--id/],
    [["runtime", "version", "get", "--id", "runtime-1"], /--version/],
    [["runtime", "version", "list"], /--id/],
    [["runtime", "endpoint", "get", "--id", "runtime-1"], /--qualifier/],
    [["runtime", "endpoint", "list"], /--id/],
  ] as const)("rejects a missing required selector for `%s`", async (args, message) => {
    expect(run([...args])).rejects.toThrow(message);
  });

  test.each([
    [["runtime", "get", "--id", LONG_RUNTIME_ID], "getRuntime"],
    [["runtime", "version", "get", "--id", LONG_RUNTIME_ID, "--version", "1"], "getRuntimeVersion"],
    [["runtime", "version", "list", "--id", LONG_RUNTIME_ID], "listRuntimeVersions"],
    [
      ["runtime", "endpoint", "get", "--id", LONG_RUNTIME_ID, "--qualifier", "DEFAULT"],
      "getRuntimeEndpoint",
    ],
    [["runtime", "endpoint", "list", "--id", LONG_RUNTIME_ID], "listRuntimeEndpoints"],
  ] as const)("accepts a service-valid long Runtime ID for `%s`", async (args, method) => {
    const result = await run([...args]);

    expect(result.runtime.calls).toHaveLength(1);
    expect(result.runtime.calls[0]?.method).toBe(method);
    expect(result.runtime.calls[0]?.args[0]).toBe(LONG_RUNTIME_ID);
  });

  test("propagates Runtime Core errors", async () => {
    await expect(
      run(["runtime", "get", "--id", "runtime-1"], (runtime) =>
        runtime.setError(new Error("runtime unavailable")),
      ),
    ).rejects.toThrow("runtime unavailable");
  });
});

describe("runtime fixture command flow", () => {
  test("replays Runtime get through the real Core", async () => {
    const out = await runFixture(["runtime", "get", "--id", RUNTIME_ID]);

    matchGolden(FIXTURES, "get.golden.json", out);
    const parsed = JSON.parse(out);
    expect(parsed.agentRuntimeId).toBe(RUNTIME_ID);
    expect(parsed.failureReason).toBe("none");
  });

  test("replays Runtime list through the real Core", async () => {
    const out = await runFixture([
      "runtime",
      "list",
      "--max-results",
      "2",
      "--next-token",
      "runtime-request-token",
    ]);

    matchGolden(FIXTURES, "list.golden.json", out);
    expect(JSON.parse(out).nextToken).toBe("runtime-response-token");
  });

  test("replays Runtime version get through the real Core", async () => {
    const out = await runFixture([
      "runtime",
      "version",
      "get",
      "--id",
      RUNTIME_ID,
      "--version",
      "2",
    ]);

    matchGolden(FIXTURES, "version-get.golden.json", out);
    expect(JSON.parse(out).agentRuntimeVersion).toBe("2");
  });

  test("replays Runtime version list through the real Core", async () => {
    const out = await runFixture([
      "runtime",
      "version",
      "list",
      "--id",
      RUNTIME_ID,
      "--max-results",
      "2",
      "--next-token",
      "version-request-token",
    ]);

    matchGolden(FIXTURES, "version-list.golden.json", out);
    expect(JSON.parse(out).nextToken).toBe("version-response-token");
  });

  test("replays Runtime endpoint get through the real Core", async () => {
    const out = await runFixture([
      "runtime",
      "endpoint",
      "get",
      "--id",
      RUNTIME_ID,
      "--qualifier",
      "DEFAULT",
    ]);

    matchGolden(FIXTURES, "endpoint-get.golden.json", out);
    const parsed = JSON.parse(out);
    expect(parsed.name).toBe("DEFAULT");
    expect(parsed.liveVersion).toBe("2");
  });

  test("replays Runtime endpoint list through the real Core", async () => {
    const out = await runFixture([
      "runtime",
      "endpoint",
      "list",
      "--id",
      RUNTIME_ID,
      "--max-results",
      "2",
      "--next-token",
      "endpoint-request-token",
    ]);

    matchGolden(FIXTURES, "endpoint-list.golden.json", out);
    expect(JSON.parse(out).nextToken).toBe("endpoint-response-token");
  });
});
