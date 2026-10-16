import type { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import {
  MAX_FRAME_SIZE,
  ShellChannel,
  ShellFramer,
  ShellSession,
  type OpenShellParams,
  type ShellSessionOptions,
} from "bedrock-agentcore/runtime";
import { Buffer } from "node:buffer";
import WebSocket from "ws";
import { InputValidationError, MalformedServiceResponseError, NetworkingError } from "../errors";
import type { HarnessShellRequest } from "../handlers/harness/types";
import type { RuntimeShellSession } from "../handlers/runtime/types";
import { parseArn } from "./arn";
import { isRetryableUpgrade, RuntimeShellSessionAdapter } from "./runtimeShell";
import type { AwsClients, CoreOptions } from "./types";
import { toClientConfig } from "./utils";

export type OpenHarnessShell = (
  request: HarnessShellRequest,
  options: CoreOptions,
) => Promise<RuntimeShellSession>;

type HarnessShellOpenerConfig = {
  createWebSocket?: ShellSessionOptions["_wsFactory"];
  initializationTimeoutMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
};

const SESSION_HEADER = "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id";
const UPGRADE_TIMEOUT_MS = 330_000;

export function createHarnessShellOpener(
  clients: AwsClients,
  config: HarnessShellOpenerConfig = {},
): OpenHarnessShell {
  const sleep = config.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return async (request, options) => {
    const client = new HarnessShellClient(clients.data(toClientConfig(options)), options, config);
    let delay = 250;
    for (let attempt = 1; ; attempt += 1) {
      try {
        const session = await client.openShell({
          runtimeArn: request.harnessArn,
          endpointName: request.qualifier,
          sessionId: request.runtimeSessionId,
          shellId: request.shellId,
          auth:
            request.bearerToken === undefined
              ? "sigv4"
              : { type: "oauth", bearerToken: request.bearerToken },
          reconnectConfig: { onReconnect: request.onReconnect },
        });
        return new RuntimeShellSessionAdapter(session);
      } catch (error) {
        if (
          (error instanceof NetworkingError && error.meta.closeCode !== 1011) ||
          attempt >= 5 ||
          !isRetryableUpgrade(error)
        )
          throw error;
        await sleep(delay);
        delay *= 2;
      }
    }
  };
}

class HarnessShellClient {
  private readonly framer = new ShellFramer();

  constructor(
    private readonly data: BedrockAgentCoreClient,
    private readonly options: CoreOptions,
    private readonly config: HarnessShellOpenerConfig,
  ) {}

  async openShell(input: OpenShellParams): Promise<ShellSession> {
    const arn = parseArn(input.runtimeArn);
    if (
      arn?.service !== "bedrock-agentcore" ||
      !/^harness\/.+$/.test(arn.resource) ||
      !/^\d{12}$/.test(arn.account)
    ) {
      throw new InputValidationError("Harness returned an invalid ARN");
    }
    if (arn.region !== this.options.region) {
      throw new InputValidationError("Harness ARN region does not match the selected Region");
    }
    let initialized!: () => void;
    let initializationFailed!: (error: unknown) => void;
    const initialization = new Promise<void>((resolve, reject) => {
      initialized = resolve;
      initializationFailed = reject;
    });
    let connected = false;
    let currentReadiness: Promise<boolean>;
    const session = new ShellSession({
      sessionId: input.sessionId,
      shellId: input.shellId,
      reconnectConfig: {
        ...input.reconnectConfig,
        onReconnect: () => {
          // Waiting here would hold the SDK's reconnect loop past its metadata timeout.
          void currentReadiness
            .then((reconnected) => input.reconnectConfig?.onReconnect?.(reconnected))
            .catch(() => {});
        },
      },
      connectFn: (shellId, sessionId) => this.connection(input, shellId, sessionId),
      _wsFactory: (url, protocols, options) => {
        const clientOptions = {
          ...options,
          handshakeTimeout: UPGRADE_TIMEOUT_MS,
          maxPayload: MAX_FRAME_SIZE,
        };
        const socket = this.config.createWebSocket
          ? this.config.createWebSocket(url, protocols, clientOptions)
          : new WebSocket(url, protocols ?? [], clientOptions);
        // Harness initialization can outlast the SDK's fixed 10-second metadata wait.
        currentReadiness = this.waitForInitialization(socket);
        currentReadiness.then(
          () => initialized(),
          (error) => {
            if (!connected) {
              initializationFailed(error);
              void session.close();
            } else {
              socket.terminate();
            }
          },
        );
        return socket;
      },
    });
    try {
      await Promise.all([session.connect(), initialization]);
      connected = true;
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }

  private async connection(input: OpenShellParams, shellId: string, sessionId: string) {
    const endpoint = this.data.config.endpointProvider({
      Region: this.options.region,
      Endpoint: this.options.endpointUrl,
    });
    const url = new URL(endpoint.url);
    if (url.protocol !== "https:") {
      throw new InputValidationError("Harness shell requires an HTTPS endpoint");
    }
    url.pathname = `${url.pathname.replace(/\/?$/, "/")}runtimes/${encodeURIComponent(input.runtimeArn)}/ws/shells`;
    url.search = new URLSearchParams({
      shellId,
      ...(input.endpointName !== undefined && { qualifier: input.endpointName }),
    }).toString();
    const headers = { [SESSION_HEADER]: sessionId };
    const websocketUrl = url.toString().replace(/^https:/, "wss:");
    if (typeof input.auth === "object" && input.auth.type === "oauth") {
      const encoded = Buffer.from(input.auth.bearerToken).toString("base64url");
      if (!input.auth.bearerToken || encoded.length > 4096) {
        throw new InputValidationError("Invalid or oversized Harness shell bearer token");
      }
      return {
        url: websocketUrl,
        headers,
        protocols: [`base64UrlBearerAuthorization.${encoded}`, "base64UrlBearerAuthorization"],
      };
    }
    const signer = await this.data.config.signer({
      name: "sigv4",
      signingName: "bedrock-agentcore",
      signingRegion: this.options.region,
      properties: {},
    });
    const signed = await signer.sign({
      method: "GET",
      protocol: url.protocol,
      hostname: url.hostname,
      ...(url.port && { port: Number(url.port) }),
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: { host: url.host, ...headers },
    });
    return {
      url: websocketUrl,
      headers: signed.headers,
    };
  }

  private waitForInitialization(socket: WebSocket): Promise<boolean> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let opened = false;
      const finish = (error?: Error, reconnected = false) => {
        clearTimeout(timer);
        socket.off("open", onOpen);
        socket.off("message", onMessage);
        socket.off("close", onClose);
        socket.off("error", onError);
        if (error) reject(error);
        else resolve(reconnected);
      };
      const onOpen = () => {
        opened = true;
        timer = setTimeout(
          () => finish(new NetworkingError("Timed out waiting for Harness shell initialization")),
          this.config.initializationTimeoutMs ?? UPGRADE_TIMEOUT_MS,
        );
      };
      const onMessage = (data: WebSocket.RawData, binary: boolean) => {
        if (!binary) return;
        try {
          const bytes = Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data as ArrayBuffer);
          const frame = this.framer.decode(bytes);
          if (frame.channel !== ShellChannel.STATUS) return;
          const status = frame.json();
          if (status.status === "Failure") {
            finish(new NetworkingError("Harness shell initialization failed"));
            return;
          }
          const metadata = status.metadata;
          if (
            metadata &&
            typeof metadata === "object" &&
            "shellId" in metadata &&
            typeof metadata.shellId === "string" &&
            metadata.shellId.length > 0
          ) {
            finish(undefined, "reconnected" in metadata && metadata.reconnected === true);
          } else {
            finish(new NetworkingError("Harness shell exited before initialization completed"));
          }
        } catch (error) {
          finish(
            new MalformedServiceResponseError("Invalid Harness shell initialization status", {
              cause: error,
            }),
          );
        }
      };
      const onClose = (code: number) =>
        opened
          ? finish(
              new NetworkingError("Harness shell closed before initialization completed", {
                meta: { closeCode: code },
              }),
            )
          : finish();
      const onError = (error: Error) => (opened ? finish(error) : finish());
      socket.once("open", onOpen);
      socket.on("message", onMessage);
      socket.once("close", onClose);
      socket.once("error", onError);
    });
  }
}
