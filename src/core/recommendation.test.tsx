import { describe, expect, test } from "bun:test";
import {
  DeleteRecommendationCommand,
  GetRecommendationCommand,
  ListRecommendationsCommand,
  StartRecommendationCommand,
  type DeleteRecommendationResponse,
  type GetRecommendationResponse,
  type ListRecommendationsResponse,
  type RecommendationConfig,
  type StartRecommendationRequest,
  type StartRecommendationResponse,
} from "@aws-sdk/client-bedrock-agentcore";
import type { AwsClients, ClientConfig } from "./types";
import { EvalClient } from "./eval";

const options = {
  region: "us-west-2",
  endpointUrl: "https://agentcore.example.test",
};
const recommendationConfig: RecommendationConfig = {
  systemPromptRecommendationConfig: {
    systemPrompt: { text: "You are a support agent." },
    agentTraces: { sessionSpans: [{ traceId: "trace-1", spanId: "span-1" }] },
  },
};

function evalClient(send: (command: unknown) => Promise<unknown>): {
  client: EvalClient;
  configs: ClientConfig[];
} {
  const configs: ClientConfig[] = [];
  return {
    client: new EvalClient({
      data: (config: ClientConfig) => {
        configs.push(config);
        return { send } as never;
      },
    } as unknown as AwsClients),
    configs,
  };
}

describe("EvalClient recommendations", () => {
  test("starts a recommendation with the request unchanged on the data plane", async () => {
    const request: StartRecommendationRequest = {
      name: "support-prompt",
      description: "Improve the support prompt",
      type: "SYSTEM_PROMPT_RECOMMENDATION",
      recommendationConfig,
      kmsKeyArn: "arn:aws:kms:us-west-2:123456789012:key/recommendations",
      tags: { team: "eval" },
    };
    const response = {
      recommendationId: "recommendation-1",
      status: "PENDING",
    } as StartRecommendationResponse;
    const { client, configs } = evalClient(async (command) => {
      expect(command).toBeInstanceOf(StartRecommendationCommand);
      expect((command as StartRecommendationCommand).input).toEqual(request);
      return response;
    });

    await expect(client.startRecommendation(request, options)).resolves.toBe(response);
    expect(configs).toEqual([{ region: "us-west-2", endpoint: "https://agentcore.example.test" }]);
  });

  test("gets a recommendation by recommendationId", async () => {
    const response = {
      recommendationId: "recommendation-1",
      status: "COMPLETED",
    } as GetRecommendationResponse;
    const { client } = evalClient(async (command) => {
      expect(command).toBeInstanceOf(GetRecommendationCommand);
      expect((command as GetRecommendationCommand).input).toEqual({
        recommendationId: "recommendation-1",
      });
      return response;
    });

    await expect(client.getRecommendation("recommendation-1", options)).resolves.toBe(response);
  });

  test("lists recommendations with pagination and statusFilter", async () => {
    const response = {
      recommendationSummaries: [],
      nextToken: "token-2",
    } as ListRecommendationsResponse;
    const { client } = evalClient(async (command) => {
      expect(command).toBeInstanceOf(ListRecommendationsCommand);
      expect((command as ListRecommendationsCommand).input).toEqual({
        nextToken: "token-1",
        maxResults: 10,
        statusFilter: "FAILED",
      });
      return response;
    });

    await expect(client.listRecommendations("token-1", 10, "FAILED", options)).resolves.toBe(
      response,
    );
  });

  test("deletes a recommendation by recommendationId", async () => {
    const response = {
      recommendationId: "recommendation-1",
      status: "DELETING",
    } as DeleteRecommendationResponse;
    const { client } = evalClient(async (command) => {
      expect(command).toBeInstanceOf(DeleteRecommendationCommand);
      expect((command as DeleteRecommendationCommand).input).toEqual({
        recommendationId: "recommendation-1",
      });
      return response;
    });

    await expect(client.deleteRecommendation("recommendation-1", options)).resolves.toBe(response);
  });
});
