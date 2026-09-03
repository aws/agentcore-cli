import { describe, expect, test } from "bun:test";
import type { GetAgentRuntimeResponse } from "@aws-sdk/client-bedrock-agentcore-control";
import { createRootHandler } from "../../index";
import type { RuntimeShellRequest, RuntimeShellSession } from "../types";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../testing";

const REGION = "us-west-2";
const RUNTIME_ID = "checkout-AbCdEf1234";
const RUNTIME_ARN = `arn:aws:bedrock-agentcore:${REGION}:123456789012:runtime/checkout-AbCdEf1234`;

function runtime(overrides: Partial<GetAgentRuntimeResponse> = {}): GetAgentRuntimeResponse {
  return {
    agentRuntimeArn: RUNTIME_ARN,
    agentRuntimeId: RUNTIME_ID,
    agentRuntimeName: "checkout",
    agentRuntimeVersion: "1",
    createdAt: new Date("2026-09-03T00:00:00Z"),
    lastUpdatedAt: new Date("2026-09-03T00:00:00Z"),
    status: "READY",
    roleArn: "arn:aws:iam::123456789012:role/runtime",
    networkConfiguration: { networkMode: "PUBLIC" },
    lifecycleConfiguration: {
      idleRuntimeSessionTimeout: 900,
      maxLifetime: 28_800,
    },
    ...overrides,
  };
}

class CompletedShell implements RuntimeShellSession {
  readonly runtimeSessionId = "session-012345678901234567890123456789";
  readonly kicked = false;
  readonly exitCode = 0;
  closed = 0;

  send(): Promise<void> {
    return Promise.resolve();
  }

  resize(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed += 1;
    return Promise.resolve();
  }

  async *[Symbol.asyncIterator]() {}
}

function harness(options: { isTTY?: boolean; runtime?: GetAgentRuntimeResponse } = {}) {
  const core = new TestCoreClient();
  core.runtime.setGetResponse(options.runtime ?? runtime());
  const shell = new CompletedShell();
  core.runtime.setShellSession(shell);
  const io = testIO({ isTTY: options.isTTY ?? true });
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  return {
    core,
    shell,
    io,
    run: (...args: string[]) =>
      root.route(["node", "agentcore", "runtime", "shell", ...args, "--region", REGION]),
  };
}

describe("runtime shell command", () => {
  test("opens a direct IAM shell and closes after the remote stream ends", async () => {
    const subject = harness();

    await subject.run("--id", RUNTIME_ID, "--qualifier", "prod");

    expect(subject.core.runtime.calls.find((call) => call.method === "getRuntime")?.args[0]).toBe(
      RUNTIME_ID,
    );
    expect(subject.core.runtime.calls.find((call) => call.method === "openRuntimeShell")).toEqual({
      method: "openRuntimeShell",
      args: [
        {
          runtimeArn: RUNTIME_ARN,
          qualifier: "prod",
          onReconnect: expect.any(Function),
        },
        { region: "us-west-2", endpointUrl: undefined },
      ],
    });
    expect(subject.shell.closed).toBe(1);
    expect(subject.io.stderr()).toContain("Connected");
    expect(subject.io.stderr()).toContain("exit 0");
  });

  test("passes CUSTOM_JWT bearer auth to Core", async () => {
    const subject = harness({
      runtime: runtime({
        authorizerConfiguration: {
          customJWTAuthorizer: {
            discoveryUrl: "https://idp.example/.well-known/openid-configuration",
          },
        },
      }),
    });

    await subject.run("--id", RUNTIME_ID, "--qualifier", "DEFAULT", "--bearer-token", "token");

    expect(
      subject.core.runtime.calls.find((call) => call.method === "openRuntimeShell")?.args[0],
    ).toMatchObject({ bearerToken: "token" });
  });

  test("reports whether reconnect preserved the existing shell", async () => {
    const subject = harness();

    await subject.run("--id", RUNTIME_ID, "--qualifier", "prod");
    const request = subject.core.runtime.calls.find((call) => call.method === "openRuntimeShell")
      ?.args[0] as RuntimeShellRequest;
    await request.onReconnect?.(true);
    await request.onReconnect?.(false);

    expect(subject.io.stderr()).toContain("Reattached to existing shell.");
    expect(subject.io.stderr()).toContain("Previous shell unavailable; started a new shell.");
  });

  test("rejects JSON mode", async () => {
    const subject = harness();

    await expect(
      subject.run("--id", RUNTIME_ID, "--qualifier", "DEFAULT", "--json"),
    ).rejects.toThrow("--json cannot be used with runtime shell");
    expect(subject.core.runtime.calls.some((call) => call.method === "openRuntimeShell")).toBe(
      false,
    );
  });

  test("requires a TTY for direct shell", async () => {
    const subject = harness({ isTTY: false });

    await expect(subject.run("--id", RUNTIME_ID, "--qualifier", "DEFAULT")).rejects.toThrow(
      "interactive mode requires a TTY",
    );
  });

  test("rejects an endpoint URL override the shell SDK cannot honor", async () => {
    const subject = harness();

    await expect(
      subject.run(
        "--id",
        RUNTIME_ID,
        "--qualifier",
        "DEFAULT",
        "--endpoint-url",
        "https://runtime.test",
      ),
    ).rejects.toThrow("runtime shell does not support --endpoint-url");
    expect(subject.core.runtime.calls.some((call) => call.method === "getRuntime")).toBe(false);
  });
});
