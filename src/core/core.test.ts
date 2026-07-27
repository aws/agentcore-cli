import { test, expect } from "bun:test";
import type { BedrockAgentCoreControlClient } from "@aws-sdk/client-bedrock-agentcore-control";
import type { IAMClient } from "@aws-sdk/client-iam";
import {
  InvokeAgentRuntimeCommandCommand,
  InvokeHarnessCommand,
  type BedrockAgentCoreClient,
} from "@aws-sdk/client-bedrock-agentcore";
import { CoreClient } from "./index";
import type { ClientConfig } from "./types";
import { toClientConfig } from "./utils";
import { createSilentLogger } from "../testing";

// A minimal stand-in for the SDK clients; CoreClient only stores and returns
// them, so an opaque tagged object is enough to assert identity/caching.
function fakeControl(config: ClientConfig): BedrockAgentCoreControlClient {
  return { config, kind: "control" } as unknown as BedrockAgentCoreControlClient;
}
function fakeData(config: ClientConfig): BedrockAgentCoreClient {
  return { config, kind: "data" } as unknown as BedrockAgentCoreClient;
}
function fakeIam(config: ClientConfig): IAMClient {
  return { config, kind: "iam" } as unknown as IAMClient;
}

test("control() constructs a client once per config and caches it", () => {
  let built = 0;
  const core = new CoreClient({
    createControlClient: (config) => {
      built++;
      return fakeControl(config);
    },
    createDataClient: fakeData,
    createIamClient: fakeIam,
    logger: createSilentLogger(),
  });

  const a = core.control({ region: "us-east-1" });
  const b = core.control({ region: "us-east-1" });

  expect(a).toBe(b);
  expect(built).toBe(1);
});

test("control() builds a distinct client per distinct config", () => {
  let built = 0;
  const core = new CoreClient({
    createControlClient: (config) => {
      built++;
      return fakeControl(config);
    },
    createDataClient: fakeData,
    createIamClient: fakeIam,
    logger: createSilentLogger(),
  });

  core.control({ region: "us-east-1" });
  core.control({ region: "us-west-2" });
  core.control({ region: "us-east-1", endpoint: "https://example" });

  expect(built).toBe(3);
});

test("data() caches independently of control()", () => {
  let controlBuilt = 0;
  let dataBuilt = 0;
  const core = new CoreClient({
    createControlClient: (config) => {
      controlBuilt++;
      return fakeControl(config);
    },
    createDataClient: (config) => {
      dataBuilt++;
      return fakeData(config);
    },
    createIamClient: fakeIam,
    logger: createSilentLogger(),
  });

  core.control({ region: "us-east-1" });
  const d1 = core.data({ region: "us-east-1" });
  const d2 = core.data({ region: "us-east-1" });

  expect(d1).toBe(d2);
  expect(controlBuilt).toBe(1);
  expect(dataBuilt).toBe(1);
});

test("exposes feature sub-clients", () => {
  const core = new CoreClient({
    createControlClient: fakeControl,
    createDataClient: fakeData,
    createIamClient: fakeIam,
    logger: createSilentLogger(),
  });
  expect(core.harness).toBeDefined();
  expect(core.memory).toBeDefined();
});

test("invokeHarness sends an InvokeHarnessCommand on the data client with the abort signal", async () => {
  // A fake data client that records what send() receives and resolves a canned
  // response, so we can assert the harness sub-client's SDK translation.
  const sent: { command: unknown; options: unknown }[] = [];
  const configs: ClientConfig[] = [];
  const response = { stream: undefined };
  const core = new CoreClient({
    createControlClient: fakeControl,
    createDataClient: (config) => {
      configs.push(config);
      return {
        config,
        kind: "data",
        send: async (command: unknown, options: unknown) => {
          sent.push({ command, options });
          return response;
        },
      } as unknown as BedrockAgentCoreClient;
    },
    createIamClient: fakeIam,
    logger: createSilentLogger(),
  });

  const request = {
    harnessArn: "arn:aws:bedrock-agentcore:us-east-1:123:harness/h-1",
    runtimeSessionId: "s".repeat(40),
    messages: [{ role: "user" as const, content: [{ text: "hi" }] }],
  };
  const controller = new AbortController();
  const result = await core.harness.invokeHarness(
    request,
    { region: "us-east-1", endpointUrl: "https://custom" },
    controller.signal,
  );

  expect(result).toBe(response);
  expect(configs).toEqual([{ region: "us-east-1", endpoint: "https://custom" }]);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.command).toBeInstanceOf(InvokeHarnessCommand);
  expect((sent[0]!.command as InvokeHarnessCommand).input).toEqual(request);
  expect(sent[0]!.options).toEqual({ abortSignal: controller.signal });
});

test("invokeHarness stream iteration rejects promptly when aborted mid-stream", async () => {
  // A stream that yields one event then hangs, like a live turn between
  // events; the SDK itself does not fail the iteration on abort at this point.
  const hangingStream: AsyncIterable<string> = {
    async *[Symbol.asyncIterator]() {
      yield "first";
      await new Promise(() => {});
    },
  };
  const core = new CoreClient({
    createControlClient: fakeControl,
    createDataClient: (config) =>
      ({
        config,
        kind: "data",
        send: async () => ({ stream: hangingStream }),
      }) as unknown as BedrockAgentCoreClient,
    createIamClient: fakeIam,
    logger: createSilentLogger(),
  });

  const controller = new AbortController();
  const response = await core.harness.invokeHarness(
    { harnessArn: "arn", runtimeSessionId: "s".repeat(40), messages: [] },
    { region: "us-east-1" },
    controller.signal,
  );

  const iterator = response.stream![Symbol.asyncIterator]();
  expect((await iterator.next()).value).toBe("first");

  const pending = iterator.next();
  controller.abort();
  expect(pending).rejects.toMatchObject({ name: "AbortError" });
});

test("invokeAgentRuntimeCommand sends the command on the data client with the abort signal", async () => {
  const sent: { command: unknown; options: unknown }[] = [];
  const core = new CoreClient({
    createControlClient: fakeControl,
    createDataClient: (config) =>
      ({
        config,
        kind: "data",
        send: async (command: unknown, options: unknown) => {
          sent.push({ command, options });
          return { statusCode: 200, stream: undefined };
        },
      }) as unknown as BedrockAgentCoreClient,
    createIamClient: fakeIam,
    logger: createSilentLogger(),
  });

  const request = {
    agentRuntimeArn: "arn:aws:bedrock-agentcore:us-east-1:123:harness/h-1",
    body: { command: "ls" },
  };
  const controller = new AbortController();
  await core.harness.invokeAgentRuntimeCommand(request, { region: "us-east-1" }, controller.signal);

  expect(sent).toHaveLength(1);
  expect(sent[0]!.command).toBeInstanceOf(InvokeAgentRuntimeCommandCommand);
  expect((sent[0]!.command as InvokeAgentRuntimeCommandCommand).input).toEqual(request);
  expect(sent[0]!.options).toEqual({ abortSignal: controller.signal });
});

test("invokeHarness returns the stream untouched when no abort signal is given", async () => {
  const stream = (async function* () {})();
  const core = new CoreClient({
    createControlClient: fakeControl,
    createDataClient: (config) =>
      ({
        config,
        kind: "data",
        send: async () => ({ stream }),
      }) as unknown as BedrockAgentCoreClient,
    createIamClient: fakeIam,
    logger: createSilentLogger(),
  });

  const response = await core.harness.invokeHarness(
    { harnessArn: "arn", runtimeSessionId: "s".repeat(40), messages: [] },
    { region: "us-east-1" },
  );
  expect(response.stream).toBe(stream);
});

test("toClientConfig maps region and omits endpoint when not overridden", () => {
  expect(toClientConfig({ region: "us-east-1" })).toEqual({ region: "us-east-1" });
});

test("toClientConfig sets endpoint only when an override is provided", () => {
  expect(toClientConfig({ region: "us-east-1", endpointUrl: "https://custom" })).toEqual({
    region: "us-east-1",
    endpoint: "https://custom",
  });
});
