import {
  MAX_FRAME_SIZE,
  RuntimeClient as AgentCoreRuntimeClient,
  ShellChannel,
  type OpenShellParams,
  type ShellFrame,
  type ShellSession,
} from "bedrock-agentcore/runtime";
import { Buffer } from "node:buffer";
import type { RuntimeShellFrame, RuntimeShellSession } from "../handlers/runtime/types";
import type { OpenRuntimeShell } from "./runtime";
import type { CoreOptions } from "./types";

export type RuntimeShellSdkOpenInput = OpenShellParams;

export type RuntimeShellSdkFrame = Pick<ShellFrame, "channel" | "payload">;

export type RuntimeShellSdkSession = Pick<
  ShellSession,
  | "shellId"
  | "sessionId"
  | "reconnected"
  | "kicked"
  | "exitCode"
  | "send"
  | "resize"
  | "close"
> &
  AsyncIterable<RuntimeShellSdkFrame>;

export interface RuntimeShellSdkClient {
  openShell(input: RuntimeShellSdkOpenInput): Promise<RuntimeShellSdkSession>;
}

export type RuntimeShellSdkClientConfig = NonNullable<
  ConstructorParameters<typeof AgentCoreRuntimeClient>[0]
>;

export type CreateRuntimeShellSdkClient = (
  config: RuntimeShellSdkClientConfig,
) => RuntimeShellSdkClient;

export type RuntimeShellOpenerConfig = {
  createClient?: CreateRuntimeShellSdkClient;
  sleep?: (delayMs: number) => Promise<void>;
};

const RETRYABLE_UPGRADE = /HTTP (409|424|429)\b/;
const MAX_ATTEMPTS = 5;
const MAX_STDIN_PAYLOAD_BYTES = MAX_FRAME_SIZE - 1;

export function createRuntimeShellOpener(config: RuntimeShellOpenerConfig = {}): OpenRuntimeShell {
  const createClient =
    config.createClient ?? ((clientConfig) => new AgentCoreRuntimeClient(clientConfig));
  const sleep =
    config.sleep ?? ((delayMs) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));

  return async (request, options) => {
    const client = createClient({
      region: options.region,
      ...(options.credentials !== undefined && {
        credentialsProvider: credentialProvider(options.credentials),
      }),
    });
    const input: RuntimeShellSdkOpenInput = {
      runtimeArn: request.runtimeArn,
      endpointName: request.qualifier,
      ...(request.runtimeSessionId !== undefined && { sessionId: request.runtimeSessionId }),
      ...(request.shellId !== undefined && { shellId: request.shellId }),
      auth:
        request.bearerToken === undefined
          ? "sigv4"
          : { type: "oauth", bearerToken: request.bearerToken },
      reconnectConfig: {
        ...(request.onReconnect !== undefined && { onReconnect: request.onReconnect }),
      },
    };

    let delayMs = 250;
    for (let attempt = 1; ; attempt += 1) {
      try {
        const session = await client.openShell(input);
        return new RuntimeShellSessionAdapter(session);
      } catch (error) {
        if (attempt >= MAX_ATTEMPTS || !isRetryableUpgrade(error)) throw error;
        await sleep(delayMs);
        delayMs *= 2;
      }
    }
  };
}

function credentialProvider(
  credentials: NonNullable<CoreOptions["credentials"]>,
): NonNullable<RuntimeShellSdkClientConfig["credentialsProvider"]> {
  return typeof credentials === "function" ? credentials : async () => credentials;
}

function isRetryableUpgrade(error: unknown): boolean {
  const reported = error instanceof Error ? error : new Error(String(error));
  return (
    RETRYABLE_UPGRADE.test(reported.message) ||
    reported.name === "TimeoutError" ||
    reported.name === "NetworkingError" ||
    reported.name === "WebSocketError"
  );
}

class RuntimeShellSessionAdapter implements RuntimeShellSession {
  constructor(private readonly session: RuntimeShellSdkSession) {}

  get runtimeSessionId(): string {
    return this.session.sessionId;
  }

  get shellId(): string {
    return this.session.shellId;
  }

  get kicked(): boolean {
    return this.session.kicked;
  }

  get exitCode(): number | null {
    return this.session.exitCode;
  }

  async send(data: Uint8Array): Promise<void> {
    for (let offset = 0; offset < data.length; offset += MAX_STDIN_PAYLOAD_BYTES) {
      await this.session.send(Buffer.from(data.subarray(offset, offset + MAX_STDIN_PAYLOAD_BYTES)));
    }
  }

  resize(columns: number, rows: number): Promise<void> {
    return this.session.resize(columns, rows);
  }

  detach(): Promise<void> {
    return this.session.close();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<RuntimeShellFrame> {
    for await (const frame of this.session) {
      if (frame.channel === ShellChannel.STDOUT) {
        yield { type: "stdout", data: Uint8Array.from(frame.payload) };
      } else if (frame.channel === ShellChannel.STDERR) {
        yield { type: "stderr", data: Uint8Array.from(frame.payload) };
      }
    }
  }
}
