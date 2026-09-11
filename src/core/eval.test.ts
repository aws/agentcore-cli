import { describe, expect, test } from "bun:test";
import {
  StartBatchEvaluationCommand,
  type BedrockAgentCoreClient,
} from "@aws-sdk/client-bedrock-agentcore";
import type { BedrockAgentCoreControlClient } from "@aws-sdk/client-bedrock-agentcore-control";
import type { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import type { IAMClient } from "@aws-sdk/client-iam";
import { CoreClient } from "./index";
import { createSilentLogger } from "../testing";
import type { OutputConfig } from "@aws-sdk/client-bedrock-agentcore";

const OPTIONS = { region: "us-west-2" };

const RAW_SOURCE = {
  origin: "raw" as const,
  dataSourceConfig: {
    cloudWatchLogs: { serviceNames: ["my_agent.DEFAULT"], logGroupNames: ["/some/group"] },
  },
};

function coreWithCapturedDataCommands() {
  const sent: unknown[] = [];
  const unusable = (name: string) => () => {
    throw new Error(`this test should not construct the ${name} client`);
  };
  const core = new CoreClient({
    createDataClient: () =>
      ({
        send: async (command: unknown) => {
          sent.push(command);
          return { batchEvaluationId: "batch-eval-1", status: "IN_PROGRESS" };
        },
      }) as unknown as BedrockAgentCoreClient,
    createControlClient: unusable("control") as unknown as () => BedrockAgentCoreControlClient,
    createIamClient: unusable("IAM") as unknown as () => IAMClient,
    createLogsClient: unusable("logs") as unknown as () => CloudWatchLogsClient,
    logger: createSilentLogger(),
  });
  const startInput = () => {
    const command = sent.find((c) => c instanceof StartBatchEvaluationCommand);
    expect(command).toBeDefined();
    return (command as StartBatchEvaluationCommand).input;
  };
  return { core, startInput };
}

describe("CoreClient.eval.startBatchEvaluation", () => {
  test("forwards outputConfig to the request unchanged", async () => {
    const outputConfig = {
      cloudWatchConfig: {
        logGroupName: "/company/agent-evaluations",
        metricsNamespace: "Company/AgentEvaluations",
        resultDestination: "DEDICATED_LOG_GROUP",
      },
    } as OutputConfig;
    const { core, startInput } = coreWithCapturedDataCommands();

    await core.eval.startBatchEvaluation(
      { name: "eval-1", evaluatorIds: ["Builtin.Helpfulness"], source: RAW_SOURCE, outputConfig },
      OPTIONS,
    );

    expect(startInput().outputConfig).toEqual(outputConfig);
  });

  test("omits outputConfig when the caller did not supply one", async () => {
    const { core, startInput } = coreWithCapturedDataCommands();

    await core.eval.startBatchEvaluation(
      { name: "eval-1", evaluatorIds: ["Builtin.Helpfulness"], source: RAW_SOURCE },
      OPTIONS,
    );

    expect(startInput().outputConfig).toBeUndefined();
  });
});
