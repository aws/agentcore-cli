import { describe, expect, test } from "bun:test";
import {
  GetHarnessCommand,
  type GetHarnessResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { InputValidationError } from "../errors";
import type { AwsClients, ClientConfig } from "./types";
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
  test("returns the underlying AgentCore Runtime identity", () => {
    expect(harnessRuntimeFromResponse("MyHarness-abc123", RESPONSE)).toEqual({
      runtimeId: "harness_MyHarness-AbC123",
      runtimeName: "harness_MyHarness",
    });
  });

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

    await expect(
      client.resolveRuntime(
        "MyHarness-abc123",
        { region: "us-west-2", endpointUrl: "https://control.test" },
        controller.signal,
      ),
    ).resolves.toEqual({
      runtimeId: "harness_MyHarness-AbC123",
      runtimeName: "harness_MyHarness",
    });
    expect(configs).toEqual([{ region: "us-west-2", endpoint: "https://control.test" }]);
  });
});
