import { describe, expect, test } from "bun:test";
import type { GetAgentRuntimeResponse } from "@aws-sdk/client-bedrock-agentcore-control";
import { createRuntimeShellOpener } from "../../../core/runtimeShell";
import { InputValidationError } from "../../../errors";
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
  readonly shellId = "server-shell";
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
    expect(subject.io.stderr()).toContain(
      `agentcore runtime shell --id ${RUNTIME_ID} --qualifier prod --session-id ${subject.shell.runtimeSessionId} --shell-id server-shell --region ${REGION}`,
    );
    expect(subject.io.stderr()).toContain("exit 0");
  });

  test("resumes the requested shell ID in the Runtime session", async () => {
    const subject = harness();

    await subject.run(
      "--id",
      RUNTIME_ID,
      "--qualifier",
      "prod",
      "--session-id",
      subject.shell.runtimeSessionId,
      "--shell-id",
      "saved-shell",
    );

    expect(
      subject.core.runtime.calls.find((call) => call.method === "openRuntimeShell")?.args[0],
    ).toMatchObject({ runtimeSessionId: subject.shell.runtimeSessionId, shellId: "saved-shell" });
  });

  test("requires a Runtime session ID with --shell-id", async () => {
    const subject = harness();

    await expect(
      subject.run("--id", RUNTIME_ID, "--qualifier", "prod", "--shell-id", "saved-shell"),
    ).rejects.toThrow("--shell-id requires --session-id");
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
    expect(subject.io.stderr()).toContain("Provide --bearer-token again when reconnecting.");
    expect(
      subject.io
        .stderr()
        .split("\n")
        .find((line) => line.startsWith("To reconnect:")),
    ).not.toContain("--bearer-token");
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

  test.each([400, 403])(
    "reports an HTTP %s rejection through the direct CLI path",
    async (statusCode) => {
      const subject = harness();
      const failure = new Error(`Server rejected WebSocket connection: HTTP ${statusCode}`);
      subject.core.runtime.openRuntimeShell = createRuntimeShellOpener({
        createClient: () => ({
          openShell: async () => {
            throw failure;
          },
        }),
      });
      const running = subject.run("--id", RUNTIME_ID, "--qualifier", "DEFAULT");
      if (statusCode === 400) {
        const error = await running.catch((error: unknown) => error);
        expect(error).toBeInstanceOf(InputValidationError);
        expect(error).toMatchObject({ cause: failure, source: "user", exitCode: 2 });
        expect((error as Error).message).toBe(
          `${failure.message}\n\nIf this Runtime is managed by a harness, open its shell with:\n` +
            "agentcore harness shell --id <harness-id>",
        );
      } else {
        await expect(running).rejects.toBe(failure);
      }
      expect(subject.io.stderr()).not.toContain("Connected");
      expect(subject.shell.closed).toBe(0);
    },
  );

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

  test("rejects --endpoint-url, which is globally disabled", async () => {
    const subject = harness();

    // --endpoint-url is temporarily disabled (unregistered as a global flag), so
    // it is rejected as an unknown option before the shell handler runs — the
    // shell SDK could not honor it anyway.
    await expect(
      subject.run(
        "--id",
        RUNTIME_ID,
        "--qualifier",
        "DEFAULT",
        "--endpoint-url",
        "https://runtime.test",
      ),
    ).rejects.toThrow("unknown option '--endpoint-url'");
    expect(subject.core.runtime.calls.some((call) => call.method === "getRuntime")).toBe(false);
  });
});
