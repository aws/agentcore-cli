import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import type { GetHarnessResponse } from "@aws-sdk/client-bedrock-agentcore-control";
import { CoreClient } from "../../../core";
import { createRootHandler } from "../../index";
import type { HarnessShellRequest } from "../types";
import type { RuntimeShellSession } from "../../runtime/types";
import {
  cleanupScreens,
  createSilentLogger,
  fixtureFactories,
  renderScreen,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
  tick,
  ttyTestIO,
  waitFor,
  waitForText,
} from "../../../testing";

const ID = "MyPDXHarness-rhkXkAE1IS";
const ARN = `arn:aws:bedrock-agentcore:us-west-2:501930284170:harness/${ID}`;
const SESSION_ID = "session-012345678901234567890123456789";
const TOKEN_SOURCE = `file://${join(import.meta.dir, "../../../testing/data/shell-token.txt")}`;

afterEach(cleanupScreens);

function subject(isTTY = true) {
  let request: HarnessShellRequest | undefined;
  let closed = 0;
  const session: RuntimeShellSession = {
    runtimeSessionId: SESSION_ID,
    kicked: false,
    exitCode: 0,
    send: async () => {},
    resize: async () => {},
    close: async () => {
      closed += 1;
    },
    async *[Symbol.asyncIterator]() {
      yield { type: "stdout", data: new TextEncoder().encode("harness output") };
    },
  };
  const core = new CoreClient({
    ...fixtureFactories(join(import.meta.dir, "../__fixtures__")),
    logger: createSilentLogger(),
    openHarnessShell: async (input, options) => {
      request = input;
      expect(options.region).toBe("us-west-2");
      return session;
    },
  });
  const io = testIO({ isTTY });
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  return {
    core,
    io,
    request: () => request,
    closed: () => closed,
    run: (...args: string[]) =>
      root.route(["node", "agentcore", "harness", "shell", ...args, "--region", "us-west-2"]),
  };
}

describe("harness shell", () => {
  test("opens the harness ARN through the real CLI/Core path and closes the terminal session", async () => {
    const value = subject();
    await value.run("--id", ID, "--qualifier", "prod", "--session-id", SESSION_ID);
    expect(value.request()).toEqual({
      harnessArn: ARN,
      qualifier: "prod",
      runtimeSessionId: SESSION_ID,
      onReconnect: expect.any(Function),
    });
    expect(value.io.stdout()).toContain("harness output");
    expect(value.io.stderr()).toContain("exit 0");
    expect(value.closed()).toBe(1);
    await value.request()?.onReconnect?.(true);
    expect(value.io.stderr()).toContain("Reattached to existing shell.");
  });

  test.each([
    [true, ["--json"], "--json cannot be used with harness shell"],
    [false, [], "interactive mode requires a TTY"],
  ] as const)(
    "rejects incompatible output mode before opening a shell",
    async (isTTY, flags, message) => {
      const value = subject(isTTY);
      await expect(value.run("--id", ID, "--qualifier", "DEFAULT", ...flags)).rejects.toThrow(
        message,
      );
      expect(value.request()).toBeUndefined();
    },
  );

  test("validates readiness and bearer authentication against Harness configuration", async () => {
    const value = subject();
    value.core.harness.getHarness = async () =>
      ({
        harness: { arn: ARN, status: "UPDATING" },
      }) as GetHarnessResponse;
    await expect(value.run("--id", ID, "--qualifier", "DEFAULT")).rejects.toThrow(
      "Harness is not ready",
    );
    expect(value.request()).toBeUndefined();

    value.core.harness.getHarness = async () =>
      ({
        harness: {
          arn: ARN,
          status: "READY",
          authorizerConfiguration: { customJWTAuthorizer: { discoveryUrl: "https://idp.example" } },
        },
      }) as GetHarnessResponse;
    await expect(value.run("--id", ID, "--qualifier", "DEFAULT")).rejects.toThrow(
      "CUSTOM_JWT Harness requires --bearer-token",
    );
    await value.run("--id", ID, "--qualifier", "DEFAULT", "--bearer-token", TOKEN_SOURCE);
    expect(value.request()?.bearerToken).toBe("token");
  });

  test("requires --id in headless mode", async () => {
    await expect(subject().run("--json")).rejects.toThrow("--id");
  });

  test("rejects inline bearer-token flags before looking up the Harness", async () => {
    const value = subject();
    const lookup = spyOn(value.core.harness, "getHarness");
    try {
      await expect(value.run("--id", ID, "--bearer-token", "inline-token")).rejects.toThrow(
        "inline secret values are not accepted",
      );
      expect(lookup).not.toHaveBeenCalled();
      expect(value.request()).toBeUndefined();
    } finally {
      lookup.mockRestore();
    }
  });
});

describe("harness shell navigation", () => {
  test("a preselected Harness goes to its endpoints without using Runtime APIs", async () => {
    const core = new TestCoreClient();
    core.harness.setListEndpointsResponse({
      endpoints: [
        {
          harnessId: ID,
          harnessName: "MyPDXHarness",
          arn: `${ARN}/endpoint/prod`,
          endpointName: "prod",
          liveVersion: "1",
          status: "READY",
          createdAt: new Date("2026-10-06T00:00:00Z"),
          updatedAt: new Date("2026-10-06T00:00:00Z"),
        },
      ],
    });
    const screen = renderScreen(`/agentcore/harness/shell/${ID}`, { core });
    await waitForText(screen.lastFrame, "prod");
    expect(core.harness.calls.some((call) => call.method === "listHarnesses")).toBe(false);
    expect(core.harness.calls.find((call) => call.method === "listHarnessEndpoints")?.args[0]).toBe(
      ID,
    );
    expect(core.runtime.calls).toEqual([]);
    await screen.press("escape");
    await waitForText(screen.lastFrame, "choose a harness to open a shell");
  });

  test("keeps CLI authentication and session context and propagates a failed shell quit", async () => {
    const core = new TestCoreClient();
    const failure = new Error("shell failed");
    core.harness.setShellSession({
      runtimeSessionId: SESSION_ID,
      kicked: false,
      exitCode: null,
      send: async () => {},
      resize: async () => {},
      close: async () => {},
      async *[Symbol.asyncIterator]() {
        yield { type: "stdout", data: new TextEncoder().encode("partial harness output") };
        throw failure;
      },
    });
    core.harness.setGetResponse({
      harness: {
        arn: ARN,
        status: "READY",
        authorizerConfiguration: { customJWTAuthorizer: { discoveryUrl: "https://idp.example" } },
      },
    } as GetHarnessResponse);
    core.harness.setListEndpointsResponse({
      endpoints: [
        {
          harnessId: ID,
          harnessName: "MyPDXHarness",
          arn: `${ARN}/endpoint/prod`,
          endpointName: "prod",
          liveVersion: "1",
          status: "READY",
          createdAt: new Date("2026-10-06T00:00:00Z"),
          updatedAt: new Date("2026-10-06T00:00:00Z"),
        },
      ],
    });
    const { streams, stdin } = ttyTestIO();
    const root = createRootHandler(core, {
      io: streams.io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
    let settled = false;
    const rendering = root
      .route([
        "node",
        "agentcore",
        "harness",
        "shell",
        "--id",
        ID,
        "--session-id",
        SESSION_ID,
        "--bearer-token",
        TOKEN_SOURCE,
        "--region",
        "us-west-2",
      ])
      .finally(() => {
        settled = true;
      });
    void rendering.catch(() => {});
    try {
      await waitFor(() => streams.stdout().includes("prod"));
      stdin.write("\r");
      await waitFor(() => streams.stdout().includes("Error: shell failed"));
      expect(
        core.harness.calls.find((call) => call.method === "openHarnessShell")?.args[0],
      ).toMatchObject({
        harnessArn: ARN,
        runtimeSessionId: SESSION_ID,
        bearerToken: "token",
        qualifier: "prod",
      });
      expect(core.runtime.calls).toEqual([]);
      stdin.write("\x03");
      await expect(rendering).rejects.toMatchObject({
        message: failure.message,
        cause: failure,
        exitCode: 1,
      });
    } finally {
      while (!settled) {
        stdin.write("\x03");
        await tick();
      }
      await rendering.catch(() => {});
    }
  });
});
