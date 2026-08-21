import { describe, expect, mock, test } from "bun:test";
import { StartBatchEvaluationCommand } from "@aws-sdk/client-bedrock-agentcore";
import { EvalClient } from "./eval";
import type { AwsClients } from "./types";

describe("EvalClient.startBatchInsights", () => {
  test("maps the semantic input to StartBatchEvaluation insights", async () => {
    const send = mock(async (_command: unknown) => ({
      batchEvaluationId: "bi-1",
      status: "RUNNING",
    }));
    const clients = {
      data: () => ({ send }),
      control: () => {
        throw new Error("unexpected control client call");
      },
      iam: () => {
        throw new Error("unexpected IAM client call");
      },
      logs: () => {
        throw new Error("unexpected Logs client call");
      },
    } as unknown as AwsClients;
    const client = new EvalClient(clients);
    const dataSourceConfig = {
      onlineEvaluationConfigSource: {
        onlineEvaluationConfigArn: "arn:aws:bedrock-agentcore:us-west-2:123:online-evaluation/oe-1",
      },
    };

    await client.startBatchInsights(
      {
        name: "insights_run",
        description: "description",
        insightIds: ["Builtin.Insight.FailureAnalysis", "Builtin.Insight.UserIntent"],
        evaluatorIds: ["Builtin.Helpfulness"],
        source: { origin: "raw", dataSourceConfig },
        kmsKeyArn: "arn:aws:kms:us-west-2:123:key/abc",
      },
      { region: "us-west-2" },
    );

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(StartBatchEvaluationCommand);
    expect((command as StartBatchEvaluationCommand).input).toEqual({
      batchEvaluationName: "insights_run",
      description: "description",
      insights: [
        { insightId: "Builtin.Insight.FailureAnalysis" },
        { insightId: "Builtin.Insight.UserIntent" },
      ],
      evaluators: [{ evaluatorId: "Builtin.Helpfulness" }],
      dataSourceConfig,
      kmsKeyArn: "arn:aws:kms:us-west-2:123:key/abc",
    });
  });
});
