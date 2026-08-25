import { describe, expect, mock, test } from "bun:test";
import {
  GetBatchEvaluationCommand,
  ListBatchEvaluationsCommand,
  type BatchEvaluationSummary,
} from "@aws-sdk/client-bedrock-agentcore";
import { ResultTruncationError } from "../errors";
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
  test("rejects an invalid logical page size before calling the service", async () => {
    const send = mock(async () => ({ batchEvaluations: [] }));
    const client = evalClient(send);

    await expect(client.listBatchInsights(undefined, 0, options)).rejects.toThrow(
      "maxResults must be a positive integer",
    );
    expect(send).not.toHaveBeenCalled();
  });

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

  test("scans sparse service pages to fill one logical Insights page", async () => {
    const insights = [insight("insights-1"), insight("insights-2")];
    const requests: unknown[] = [];
    const client = evalClient(async (command) => {
      requests.push(command.input);
      switch (command.input.nextToken) {
        case undefined:
          return {
            batchEvaluations: [evaluation("evaluation-1")],
            nextToken: "page-2",
          };
        case "page-2":
          return {
            batchEvaluations: [insights[0], evaluation("evaluation-2")],
            nextToken: "page-3",
          };
        default:
          return {
            batchEvaluations: [evaluation("evaluation-3"), insights[1]],
          };
      }
    });

    await expect(client.listBatchInsights(undefined, 2, options)).resolves.toEqual({
      batchEvaluations: insights,
      nextToken: undefined,
    });
    expect(requests).toEqual([
      { nextToken: undefined, maxResults: undefined },
      { nextToken: "page-2", maxResults: undefined },
      { nextToken: "page-3", maxResults: undefined },
    ]);
  });

  test("replays the exact Batch Evaluation prefix without skipping the next Insight", async () => {
    const firstInsight = insight("insights-1");
    const secondInsight = insight("insights-2");
    const requests: unknown[] = [];
    const client = evalClient(async (command) => {
      requests.push(command.input);

      if (command.input.nextToken === "after-insights-1") {
        return {
          batchEvaluations: [evaluation("evaluation-2"), secondInsight],
        };
      }
      if (command.input.maxResults === 2) {
        return {
          batchEvaluations: [evaluation("evaluation-1"), firstInsight],
          nextToken: "after-insights-1",
        };
      }
      return {
        batchEvaluations: [
          evaluation("evaluation-1"),
          firstInsight,
          evaluation("evaluation-2"),
          secondInsight,
        ],
      };
    });

    const first = await client.listBatchInsights(undefined, 1, options);
    const second = await client.listBatchInsights(first.nextToken, 1, options);

    expect(first).toEqual({
      batchEvaluations: [firstInsight],
      nextToken: "after-insights-1",
    });
    expect(second).toEqual({
      batchEvaluations: [secondInsight],
      nextToken: undefined,
    });
    expect(requests).toEqual([
      { nextToken: undefined, maxResults: undefined },
      { nextToken: undefined, maxResults: 2 },
      { nextToken: "after-insights-1", maxResults: undefined },
    ]);
  });

  test("returns a token only when it leads to another Insights job", async () => {
    const firstInsight = insight("insights-1");
    const secondInsight = insight("insights-2");
    const client = evalClient(async (command) => {
      if (command.input.nextToken === "page-2") {
        return { batchEvaluations: [evaluation("evaluation-2"), secondInsight] };
      }
      return {
        batchEvaluations: [firstInsight, evaluation("evaluation-1")],
        nextToken: "page-2",
      };
    });

    await expect(client.listBatchInsights(undefined, 1, options)).resolves.toEqual({
      batchEvaluations: [firstInsight],
      nextToken: "page-2",
    });
  });

  test("throws when Insights discovery exceeds the Batch Evaluation scan cap", async () => {
    let calls = 0;
    const client = evalClient(async () => {
      calls += 1;
      return { batchEvaluations: [], nextToken: `page-${calls}` };
    });

    await expect(client.listBatchInsights(undefined, 1, options)).rejects.toThrow(
      ResultTruncationError,
    );
    expect(calls).toBe(101);
  });
});
