import { describe, expect, test } from "bun:test";
import { MAX_FRAME_SIZE, ShellChannel } from "bedrock-agentcore/runtime";
import type { RuntimeShellRequest } from "../handlers/runtime/types";
import {
  createRuntimeShellOpener,
  type RuntimeShellSdkClient,
  type RuntimeShellSdkSession,
} from "./runtimeShell";

const REQUEST: RuntimeShellRequest = {
  runtimeArn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/checkout-AbCdEf1234",
  qualifier: "prod",
  runtimeSessionId: "session-012345678901234567890123456789",
};

function sdkSession(
  frames: { channel: ShellChannel; payload: Buffer }[] = [],
): RuntimeShellSdkSession & { closed: number } {
  return {
    sessionId: "server-session",
    reconnected: false,
    kicked: false,
    exitCode: 0,
    closed: 0,
    send: async () => {},
    resize: async () => {},
    async close() {
      this.closed += 1;
    },
    async *[Symbol.asyncIterator]() {
      yield* frames;
    },
  };
}

describe("createRuntimeShellOpener", () => {
  test("constructs a SigV4 client from Core options and opens the requested shell", async () => {
    const clients: unknown[] = [];
    const opens: unknown[] = [];
    const session = sdkSession();
    const opener = createRuntimeShellOpener({
      createClient: (config) => {
        clients.push(config);
        return {
          openShell: async (input) => {
            opens.push(input);
            return session;
          },
        };
      },
      sleep: async () => {},
    });
    const credentials = {
      accessKeyId: "access",
      secretAccessKey: "secret",
      sessionToken: "session",
    };

    const result = await opener(REQUEST, {
      region: "us-west-2",
      endpointUrl: "https://runtime.test",
      credentials,
    });

    expect(clients).toEqual([
      {
        region: "us-west-2",
        credentialsProvider: expect.any(Function),
      },
    ]);
    await expect(
      (clients[0] as { credentialsProvider: () => Promise<unknown> }).credentialsProvider(),
    ).resolves.toEqual(credentials);
    expect(opens).toEqual([
      {
        runtimeArn: REQUEST.runtimeArn,
        endpointName: "prod",
        sessionId: REQUEST.runtimeSessionId,
        auth: "sigv4",
        reconnectConfig: {},
      },
    ]);
    expect(result.runtimeSessionId).toBe("server-session");
  });

  test("uses OAuth auth for a bearer token", async () => {
    const opens: unknown[] = [];
    const opener = createRuntimeShellOpener({
      createClient: () => ({
        openShell: async (input) => {
          opens.push(input);
          return sdkSession();
        },
      }),
      sleep: async () => {},
    });

    await opener({ ...REQUEST, bearerToken: "token" }, { region: "us-west-2" });

    expect(opens).toEqual([
      expect.objectContaining({ auth: { type: "oauth", bearerToken: "token" } }),
    ]);
  });

  test("translates stdout and stderr frames and delegates writes", async () => {
    const sent: (string | Buffer)[] = [];
    const resizes: unknown[] = [];
    const session = sdkSession([
      { channel: ShellChannel.STDOUT, payload: Buffer.from("out") },
      { channel: ShellChannel.STATUS, payload: Buffer.alloc(0) },
      { channel: ShellChannel.STDERR, payload: Buffer.from("err") },
    ]);
    session.send = async (data) => {
      sent.push(data);
    };
    session.resize = async (columns, rows) => {
      resizes.push({ columns, rows });
    };
    const opener = createRuntimeShellOpener({
      createClient: (): RuntimeShellSdkClient => ({ openShell: async () => session }),
      sleep: async () => {},
    });

    const result = await opener(REQUEST, { region: "us-west-2" });
    const frames = [];
    for await (const frame of result) frames.push(frame);
    await result.send(Uint8Array.from([1, 2]));
    await result.resize(100, 40);
    await result.close();

    expect(frames).toEqual([
      { type: "stdout", data: new TextEncoder().encode("out") },
      { type: "stderr", data: new TextEncoder().encode("err") },
    ]);
    expect(sent).toEqual([Buffer.from([1, 2])]);
    expect(Buffer.isBuffer(sent[0])).toBe(true);
    expect(resizes).toEqual([{ columns: 100, rows: 40 }]);
    expect(session.closed).toBe(1);
  });

  test("splits large terminal writes at the shell protocol frame limit", async () => {
    const sent: Buffer[] = [];
    const session = sdkSession();
    session.send = async (data) => {
      if (typeof data === "string") throw new Error("expected Buffer");
      sent.push(Buffer.from(data));
    };
    const opener = createRuntimeShellOpener({
      createClient: () => ({ openShell: async () => session }),
      sleep: async () => {},
    });
    const result = await opener(REQUEST, { region: "us-west-2" });
    const paste = Buffer.alloc(MAX_FRAME_SIZE + 1, 0x61);

    await result.send(paste);

    expect(sent.map((frame) => frame.byteLength)).toEqual([MAX_FRAME_SIZE - 1, 2]);
    expect(Buffer.concat(sent)).toEqual(paste);
  });

  test("retries retryable initial upgrade failures", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const opener = createRuntimeShellOpener({
      createClient: () => ({
        openShell: async () => {
          attempts += 1;
          if (attempts < 3) throw new Error("Server rejected WebSocket connection: HTTP 424");
          return sdkSession();
        },
      }),
      sleep: async (delay) => {
        delays.push(delay);
      },
    });

    await opener(REQUEST, { region: "us-west-2" });

    expect(attempts).toBe(3);
    expect(delays).toEqual([250, 500]);
  });

  test("does not retry a non-retryable failure", async () => {
    let attempts = 0;
    const failure = new Error("Server rejected WebSocket connection: HTTP 403");
    const opener = createRuntimeShellOpener({
      createClient: () => ({
        openShell: async () => {
          attempts += 1;
          throw failure;
        },
      }),
      sleep: async () => {},
    });

    await expect(opener(REQUEST, { region: "us-west-2" })).rejects.toBe(failure);
    expect(attempts).toBe(1);
  });
});
