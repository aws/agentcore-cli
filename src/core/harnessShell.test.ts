import { describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import type { ShellSessionOptions } from "bedrock-agentcore/runtime";
import type { AwsClients, ClientConfig } from "./types";
import { createHarnessShellOpener } from "./harnessShell";
import { waitFor } from "../testing";

const ARN = "arn:aws:bedrock-agentcore:us-west-2:123456789012:harness/checkout-AbCdEf1234";
const SESSION = "session-012345678901234567890123456789";
class TestSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  readonly sent: Buffer[] = [];

  open(confirmation = true) {
    this.readyState = WebSocket.OPEN;
    this.emit("upgrade", {
      headers: {
        "x-amzn-bedrock-agentcore-runtime-session-id": SESSION,
        "x-amzn-bedrock-agentcore-shell-id": "server-shell",
      },
    });
    this.emit("open");
    if (confirmation) this.confirm();
  }

  confirm(reconnected = false) {
    this.emit(
      "message",
      Buffer.concat([
        Buffer.from([3]),
        Buffer.from(
          JSON.stringify({
            kind: "Status",
            status: "Success",
            metadata: { shellId: "server-shell", reconnected },
          }),
        ),
      ]),
      true,
    );
  }

  send(data: Buffer, callback?: (error?: Error) => void) {
    this.sent.push(Buffer.from(data));
    callback?.();
  }

  ping() {
    this.emit("pong");
  }

  close(code = 1000) {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code, Buffer.alloc(0));
  }

  terminate() {
    this.close(1006);
  }
}

function subject(
  start: (socket: TestSocket) => void = (socket) => socket.open(),
  initializationTimeoutMs?: number,
) {
  const signatures: { headers: Record<string, string> }[] = [];
  const configs: ClientConfig[] = [];
  const connections: {
    url: string;
    protocols?: string[];
    options?: WebSocket.ClientOptions;
    socket: TestSocket;
  }[] = [];
  const data = {
    config: {
      endpointProvider: () => ({
        url: new URL("https://bedrock-agentcore.us-west-2.amazonaws.com"),
      }),
      signer: async (options: unknown) => {
        expect(options).toMatchObject({
          signingName: "bedrock-agentcore",
          signingRegion: "us-west-2",
        });
        return {
          sign: async (request: { headers: Record<string, string> }) => {
            signatures.push(request);
            return { ...request, headers: { ...request.headers, authorization: "signed" } };
          },
        };
      },
    },
  } as unknown as BedrockAgentCoreClient;
  const clients = {
    data: (config: ClientConfig) => {
      configs.push(config);
      return data;
    },
  } as unknown as AwsClients;
  const createWebSocket: NonNullable<ShellSessionOptions["_wsFactory"]> = (
    url,
    protocols,
    options,
  ) => {
    const socket = new TestSocket();
    connections.push({ url, protocols, options, socket });
    queueMicrotask(() => start(socket));
    return socket as unknown as WebSocket;
  };
  return {
    signatures,
    configs,
    connections,
    open: createHarnessShellOpener(clients, {
      createWebSocket,
      initializationTimeoutMs,
      sleep: async () => {},
    }),
  };
}

describe("Harness shell connection", () => {
  test("signs the Harness ARN, qualifier and session using Core credentials and adapts the SDK session", async () => {
    const value = subject();
    const credentials = { accessKeyId: "access", secretAccessKey: "secret" };
    const session = await value.open(
      { harnessArn: ARN, qualifier: "prod", runtimeSessionId: SESSION, shellId: "saved-shell" },
      {
        region: "us-west-2",
        credentials,
      },
    );
    try {
      const connection = value.connections[0]!;
      const url = new URL(connection.url);
      expect(decodeURIComponent(url.pathname)).toBe(`/runtimes/${ARN}/ws/shells`);
      expect(url.searchParams.get("qualifier")).toBe("prod");
      expect(url.searchParams.get("shellId")).toBe("saved-shell");
      expect(value.configs).toEqual([{ region: "us-west-2", credentials }]);
      expect(connection.protocols).toBeUndefined();
      expect(connection.options?.handshakeTimeout).toBe(330_000);
      expect(value.signatures[0]?.headers["X-Amzn-Bedrock-AgentCore-Runtime-Session-Id"]).toBe(
        SESSION,
      );
      expect(connection.options?.headers?.authorization).toBe("signed");
      expect(session.runtimeSessionId).toBe(SESSION);
      expect(session.shellId).toBe("server-shell");
      await session.send(Buffer.from("echo hello\n"));
      await session.resize(100, 40);
      expect(connection.socket.sent[0]![0]).toBe(0);
      expect(JSON.parse(connection.socket.sent[1]!.subarray(1).toString())).toEqual({
        width: 100,
        height: 40,
      });
      connection.socket.emit(
        "message",
        Buffer.concat([Buffer.from([1]), Buffer.from("hello")]),
        true,
      );
      expect(await session[Symbol.asyncIterator]().next()).toEqual({
        done: false,
        value: { type: "stdout", data: new TextEncoder().encode("hello") },
      });
    } finally {
      await session.close();
    }
  });

  test("uses bearer subprotocols without SigV4", async () => {
    const value = subject();
    const session = await value.open(
      {
        harnessArn: ARN,
        qualifier: "DEFAULT",
        bearerToken: "secret-token",
      },
      { region: "us-west-2" },
    );
    try {
      expect(value.signatures).toEqual([]);
      expect(value.connections[0]?.protocols).toEqual([
        `base64UrlBearerAuthorization.${Buffer.from("secret-token").toString("base64url")}`,
        "base64UrlBearerAuthorization",
      ]);
    } finally {
      await session.close();
    }
  });

  test("waits for Harness initialization even after the SDK metadata wait expires", async () => {
    const setTimer = globalThis.setTimeout;
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: (...args: any[]) => void,
      delay?: number,
      ...args: any[]
    ) => setTimer(callback, delay === 10_000 ? 5 : delay, ...args)) as typeof setTimeout);
    const value = subject((socket) => socket.open(false));
    let connected = false;
    const opening = value
      .open({ harnessArn: ARN, qualifier: "DEFAULT" }, { region: "us-west-2" })
      .then((session) => {
        connected = true;
        return session;
      });
    try {
      await new Promise((resolve) => setTimer(resolve, 20));
      expect(connected).toBe(false);
      value.connections[0]!.socket.confirm();
      await (await opening).close();
    } finally {
      timer.mockRestore();
    }
  });

  test("closes an uninitialized shell when the application timeout expires", async () => {
    const value = subject((socket) => socket.open(false), 10);
    await expect(
      value.open({ harnessArn: ARN, qualifier: "DEFAULT" }, { region: "us-west-2" }),
    ).rejects.toThrow("Timed out waiting for Harness shell initialization");
    expect(value.connections[0]?.socket.readyState).toBe(WebSocket.CLOSED);
    const failed = subject((socket) => {
      socket.open(false);
      socket.emit(
        "message",
        Buffer.concat([
          Buffer.from([3]),
          Buffer.from(JSON.stringify({ status: "Failure", metadata: { shellId: "server-shell" } })),
        ]),
        true,
      );
    });
    await expect(
      failed.open({ harnessArn: ARN, qualifier: "DEFAULT" }, { region: "us-west-2" }),
    ).rejects.toThrow("Harness shell initialization failed");
    expect(failed.connections[0]?.socket.readyState).toBe(WebSocket.CLOSED);
  });

  test.each(["close", "timeout"])(
    "recovers when a reconnect initialization fails by %s",
    async (failure) => {
      const setTimer = globalThis.setTimeout;
      const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
        callback: (...args: any[]) => void,
        delay?: number,
        ...args: any[]
      ) => setTimer(callback, delay === 10_000 ? 5 : delay, ...args)) as typeof setTimeout);
      let attempts = 0;
      const value = subject((socket) => {
        socket.open(false);
        if (++attempts === 2) {
          if (failure === "close") setTimer(() => socket.terminate(), 15);
        } else {
          socket.confirm(attempts > 1);
          if (attempts > 1) {
            setTimer(
              () =>
                socket.emit(
                  "message",
                  Buffer.concat([Buffer.from([1]), Buffer.from("recovered")]),
                  true,
                ),
              15,
            );
          }
        }
      }, 20);
      const outcomes: boolean[] = [];
      let session: Awaited<ReturnType<typeof value.open>> | undefined;
      try {
        session = await value.open(
          {
            harnessArn: ARN,
            qualifier: "DEFAULT",
            runtimeSessionId: SESSION,
            onReconnect: (reconnected) => {
              outcomes.push(reconnected);
            },
          },
          { region: "us-west-2" },
        );
        const output = session[Symbol.asyncIterator]().next();
        let received = false;
        void output
          .finally(() => {
            received = true;
          })
          .catch(() => {});
        value.connections[0]!.socket.terminate();
        await waitFor(() => outcomes.includes(true), 3000);
        expect(value.connections.length).toBeGreaterThanOrEqual(3);
        expect(value.connections[1]!.socket.readyState).toBe(WebSocket.CLOSED);
        await waitFor(() => received);
        await expect(output).resolves.toEqual({
          done: false,
          value: { type: "stdout", data: new TextEncoder().encode("recovered") },
        });
        expect(
          value.connections.flatMap(({ socket }) => socket.sent).some((frame) => frame[0] === 255),
        ).toBe(false);
        for (const connection of value.connections.slice(1)) {
          expect(new URL(connection.url).searchParams.get("shellId")).toBe("server-shell");
        }
        const socket = value.connections.at(-1)!.socket;
        await session.send(Buffer.from("pwd\n"));
        expect(socket.sent[0]![0]).toBe(0);
      } finally {
        await session?.close();
        timer.mockRestore();
      }
    },
  );

  test("retries provisioning/server failures but not an authorization rejection", async () => {
    for (const failure of ["upgrade", "initialization"]) {
      let attempts = 0;
      const value = subject((socket) => {
        if (++attempts === 1) {
          if (failure === "upgrade") {
            socket.emit("unexpected-response", {}, { statusCode: 409, resume: () => {} });
          } else {
            socket.open(false);
            socket.readyState = WebSocket.CLOSED;
            socket.emit("close", 1011, Buffer.alloc(0));
          }
        } else {
          socket.open();
        }
      });
      await (
        await value.open({ harnessArn: ARN, qualifier: "DEFAULT" }, { region: "us-west-2" })
      ).close();
      expect(attempts).toBe(2);
    }
    const denied = subject((socket) =>
      socket.emit("unexpected-response", {}, { statusCode: 403, resume: () => {} }),
    );
    await expect(
      denied.open({ harnessArn: ARN, qualifier: "DEFAULT" }, { region: "us-west-2" }),
    ).rejects.toThrow("HTTP 403");
    expect(denied.connections).toHaveLength(1);
  });
});
