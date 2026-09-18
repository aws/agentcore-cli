import { describe, expect, mock, test } from "bun:test";
import {
  GetBatchEvaluationCommand,
  ListBatchEvaluationsCommand,
  StartBatchEvaluationCommand,
  type BatchEvaluationSummary,
} from "@aws-sdk/client-bedrock-agentcore";
import { GetOnlineEvaluationConfigCommand } from "@aws-sdk/client-bedrock-agentcore-control";
import type { AwsClients } from "./types";
import { EvalClient } from "./eval";

const options = { region: "us-west-2", endpointUrl: "https://agentcore.example.test" };

function insight(id: string): BatchEvaluationSummary {
  return {
    batchEvaluationId: id,
    insights: [{ insightId: "Builtin.Insight.FailureAnalysis" }],
  } as BatchEvaluationSummary;
}

function evaluation(id: string): BatchEvaluationSummary {
  return {
    batchEvaluationId: id,
    evaluators: [{ evaluatorId: "Builtin.Correctness" }],
  } as BatchEvaluationSummary;
}

function evalClient(send: (command: ListBatchEvaluationsCommand) => Promise<unknown>): EvalClient {
  return new EvalClient({
    data: () => ({ send: mock(send) }) as never,
  } as unknown as AwsClients);
}

function getEvalClient(send: (command: GetBatchEvaluationCommand) => Promise<unknown>): EvalClient {
  return new EvalClient({
    data: () => ({ send: mock(send) }) as never,
  } as unknown as AwsClients);
}

describe("EvalClient.getBatchInsights", () => {
  test("gets an Insights job without reading CloudWatch evaluation results", async () => {
    const job = {
      batchEvaluationId: "insights-1",
      batchEvaluationArn:
        "arn:aws:bedrock-agentcore:us-west-2:123456789012:batch-evaluate/insights-1",
      batchEvaluationName: "insights-1",
      status: "COMPLETED" as const,
      createdAt: new Date("2026-08-25T12:00:00.000Z"),
      insights: [{ insightId: "Builtin.Insight.FailureAnalysis" }],
      outputConfig: {
        cloudWatchConfig: {
          logGroupName: "/aws/example",
          logStreamName: "results",
        },
      },
    };
    const client = getEvalClient(async (command) => {
      expect(command).toBeInstanceOf(GetBatchEvaluationCommand);
      expect(command.input).toEqual({ batchEvaluationId: "insights-1" });
      return job;
    });

    await expect(client.getBatchInsights("insights-1", options)).resolves.toEqual(job);
  });

  test("rejects an evaluator-only Batch Evaluation", async () => {
    const client = getEvalClient(async () => evaluation("evaluation-1"));

    await expect(client.getBatchInsights("evaluation-1", options)).rejects.toThrow(
      'batch evaluation "evaluation-1" is not a batch insights run',
    );
  });
});

describe("EvalClient.listBatchInsights", () => {
  test("filters the final Batch Evaluation page", async () => {
    const insightsJob = insight("insights-1");
    const client = evalClient(async (command) => {
      expect(command).toBeInstanceOf(ListBatchEvaluationsCommand);
      expect(command.input).toEqual({ nextToken: "page-2", maxResults: undefined });
      return { batchEvaluations: [evaluation("evaluation-1"), insightsJob] };
    });

    await expect(client.listBatchInsights("page-2", 10, options)).resolves.toEqual({
      batchEvaluations: [insightsJob],
      nextToken: undefined,
    });
  });
});

describe("EvalClient.startBatchInsights", () => {
  test("resolves an online evaluation ID to its ARN and omits analysis configuration", async () => {
    const arn =
      "arn:aws:bedrock-agentcore:us-west-2:123456789012:online-evaluation-config/config-1";
    const client = new EvalClient({
      control: () =>
        ({
          send: mock(async (command: GetOnlineEvaluationConfigCommand) => {
            expect(command).toBeInstanceOf(GetOnlineEvaluationConfigCommand);
            expect(command.input).toEqual({ onlineEvaluationConfigId: "config-1" });
            return { onlineEvaluationConfigArn: arn };
          }),
        }) as never,
      data: () =>
        ({
          send: mock(async (command: StartBatchEvaluationCommand) => {
            expect(command).toBeInstanceOf(StartBatchEvaluationCommand);
            expect(command.input).toEqual({
              batchEvaluationName: "insights-1",
              dataSourceConfig: {
                onlineEvaluationConfigSource: {
                  onlineEvaluationConfigArn: arn,
                  timeRange: undefined,
                },
              },
              description: undefined,
              evaluators: undefined,
              insights: undefined,
              kmsKeyArn: undefined,
            });
            return {};
          }),
        }) as never,
    } as unknown as AwsClients);

    await client.startBatchInsights(
      {
        name: "insights-1",
        source: { origin: "online-eval", onlineEvaluationConfigId: "config-1" },
      },
      options,
    );
  });

  test("uses an online evaluation ARN without a control-plane lookup", async () => {
    const arn =
      "arn:aws:bedrock-agentcore:us-west-2:123456789012:online-evaluation-config/config-1";
    const client = new EvalClient({
      control: () =>
        ({
          send: mock(async () => {
            throw new Error("unexpected control-plane lookup");
          }),
        }) as never,
      data: () =>
        ({
          send: mock(async (command: StartBatchEvaluationCommand) => {
            expect(command.input.dataSourceConfig).toEqual({
              onlineEvaluationConfigSource: {
                onlineEvaluationConfigArn: arn,
                timeRange: undefined,
              },
            });
            return {};
          }),
        }) as never,
    } as unknown as AwsClients);

    await client.startBatchInsights(
      {
        name: "insights-1",
        source: { origin: "online-eval", onlineEvaluationConfigId: arn },
      },
      options,
    );
  });
});
