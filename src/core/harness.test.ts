import { describe, expect, test } from "bun:test";
import {
  GetHarnessCommand,
  type GetHarnessResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { InvokeHarnessCommand } from "@aws-sdk/client-bedrock-agentcore";
import { InputValidationError } from "../errors";
import type { AwsClients, ClientConfig, DataClientConfig } from "./types";
import { HarnessClient, harnessRuntimeFromResponse } from "./harness";

const RESPONSE = {
  harness: {
    environment: {
      agentCoreRuntimeEnvironment: {
        agentRuntimeId: "harness_MyHarness-AbC123",
        agentRuntimeName: "harness_MyHarness",
      },
    },
  },
} as GetHarnessResponse;

describe("harnessRuntimeFromResponse", () => {
  test("rejects a harness without a resolvable Runtime environment", () => {
    expect(() =>
      harnessRuntimeFromResponse("MyHarness-abc123", {
        harness: { environment: { $unknown: ["futureProvider", {}] } },
      } as GetHarnessResponse),
    ).toThrow(InputValidationError);
  });
});

describe("HarnessClient.resolveRuntime", () => {
  test("gets the harness with the configured client and forwards cancellation", async () => {
    const configs: ClientConfig[] = [];
    const controller = new AbortController();
    const clients = {
      control: (config: ClientConfig) => {
        configs.push(config);
        return {
          send: async (command: unknown, options?: { abortSignal?: AbortSignal }) => {
            expect(command).toBeInstanceOf(GetHarnessCommand);
            expect((command as GetHarnessCommand).input).toEqual({
              harnessId: "MyHarness-abc123",
            });
            expect(options?.abortSignal).toBe(controller.signal);
            return RESPONSE;
          },
        };
      },
    } as unknown as AwsClients;
    const client = new HarnessClient(clients);

    await client.resolveRuntime(
      "MyHarness-abc123",
      { region: "us-west-2", endpointUrl: "https://control.test" },
      controller.signal,
    );
    expect(configs).toEqual([{ region: "us-west-2", endpoint: "https://control.test" }]);
  });
});

describe("HarnessClient.invokeHarness", () => {
  const REQUEST = {
    harnessArn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:harness/MyHarness-abc123",
    runtimeSessionId: "s".repeat(33),
    messages: [{ role: "user" as const, content: [{ text: "hi" }] }],
  };

  async function invoke(bearerToken?: string) {
    const configs: DataClientConfig[] = [];
    const inputs: unknown[] = [];
    const clients = {
      data: (config: DataClientConfig) => {
        configs.push(config);
        return {
          send: async (command: unknown) => {
            expect(command).toBeInstanceOf(InvokeHarnessCommand);
            inputs.push((command as InvokeHarnessCommand).input);
            return {};
          },
        };
      },
    } as unknown as AwsClients;
    await new HarnessClient(clients).invokeHarness(
      { ...REQUEST, ...(bearerToken !== undefined && { bearerToken }) },
      { region: "us-west-2" },
    );
    return { configs, inputs };
  }

  test("routes a bearer token to the data client config, not the request", async () => {
    const { configs, inputs } = await invoke("jwt-123");
    expect(configs).toEqual([{ region: "us-west-2", bearerToken: "jwt-123" }]);
    expect(inputs).toEqual([REQUEST]);
  });

  test("uses the SigV4 client without a bearer token", async () => {
    const { configs, inputs } = await invoke();
    expect(configs).toEqual([{ region: "us-west-2" }]);
    expect(inputs).toEqual([REQUEST]);
  });
});
