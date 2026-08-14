import { describe, expect, test } from "bun:test";
import {
  GetAgentRuntimeCommand,
  type BedrockAgentCoreControlClient,
} from "@aws-sdk/client-bedrock-agentcore-control";
import type { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import {
  GetQueryResultsCommand,
  ResourceNotFoundException,
  StartQueryCommand,
  type CloudWatchLogsClient,
  type ResultField,
} from "@aws-sdk/client-cloudwatch-logs";
import type { IAMClient } from "@aws-sdk/client-iam";
import { CloudWatchQueryError, ResourceNotFoundError } from "../errors";
import type { Logger } from "../logging";
import { EvalClient } from "./eval";
import type { AwsClients } from "./types";

const OPTIONS = { region: "us-west-2" };
const RUNTIME_ID = "runtime-1";
const RUNTIME_LOG_GROUP = "/aws/bedrock-agentcore/runtimes/runtime-1-DEFAULT";

type QueryFailureStatus = "Failed" | "Cancelled" | "Timeout";

type LogsOptions = {
  malformedRows?: ResultField[][];
  missingRuntimeLogGroup?: boolean;
  status?: QueryFailureStatus;
};

function subject(options: LogsOptions = {}, logger?: Logger): EvalClient {
  const control = {
    send: async (command: unknown) => {
      if (command instanceof GetAgentRuntimeCommand) {
        return { agentRuntimeId: "runtime-1", agentRuntimeName: "agent-1" };
      }
      throw new Error(`unexpected control command: ${(command as object).constructor.name}`);
    },
  } as unknown as BedrockAgentCoreControlClient;

  const logs = {
    send: async (command: unknown) => {
      if (command instanceof StartQueryCommand) {
        const logGroup = command.input.logGroupNames?.[0];
        if (options.missingRuntimeLogGroup && logGroup !== "aws/spans") {
          throw new ResourceNotFoundException({
            $metadata: {},
            message: "log group does not exist",
          });
        }
        return { queryId: logGroup === "aws/spans" ? "shared-query" : "runtime-query" };
      }
      if (command instanceof GetQueryResultsCommand) {
        return {
          status: options.status ?? "Complete",
          results: command.input.queryId === "runtime-query" ? (options.malformedRows ?? []) : [],
        };
      }
      throw new Error(`unexpected logs command: ${(command as object).constructor.name}`);
    },
  } as unknown as CloudWatchLogsClient;

  const clients: AwsClients = {
    control: () => control,
    data: () => ({}) as BedrockAgentCoreClient,
    iam: () => ({}) as IAMClient,
    logs: () => logs,
  };
  return new EvalClient(clients, globalThis.fetch, logger);
}

function telemetryRow(sessionId: string, message: string): ResultField[] {
  return [
    { field: "@message", value: message },
    { field: "sessionId", value: sessionId },
  ];
}

describe("EvalClient on-demand trace collection", () => {
  test("reports a missing runtime log group as ResourceNotFoundError", async () => {
    const error = await subject({ missingRuntimeLogGroup: true })
      .getTracesForAgent({ agent: RUNTIME_ID, sessionIds: ["session-1"] }, OPTIONS)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ResourceNotFoundError);
    expect(error).toMatchObject({
      source: "user",
      meta: {
        agent: RUNTIME_ID,
        logGroupName: RUNTIME_LOG_GROUP,
      },
    });
    expect((error as Error).cause).toBeInstanceOf(ResourceNotFoundException);
  });

  test.each(["Failed", "Cancelled", "Timeout"] as const)(
    "reports CloudWatch query status %s as CloudWatchQueryError",
    async (status) => {
      const error = await subject({ status })
        .getTracesForAgent({ agent: RUNTIME_ID, sessionIds: ["session-1"] }, OPTIONS)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(CloudWatchQueryError);
      expect(error).toMatchObject({
        source: "service",
        meta: { status },
      });
    },
  );

  test("warns once when malformed telemetry records are skipped", async () => {
    const warnings: string[] = [];
    const logger: Logger = {
      debug: () => {},
      info: () => {},
      warn: (...messages) => warnings.push(messages.join(" ")),
      error: () => {},
      child: () => logger,
    };
    const rows = [
      telemetryRow(
        "session-1",
        JSON.stringify({ kind: "SERVER", traceId: "trace-1", spanId: "span-1" }),
      ),
      telemetryRow("session-1", "{"),
      telemetryRow("session-1", "not-json"),
    ];

    const traces = await subject({ malformedRows: rows }, logger).getTracesForAgent(
      { agent: RUNTIME_ID, sessionIds: ["session-1"] },
      OPTIONS,
    );

    expect(traces).toHaveLength(1);
    expect(warnings).toEqual(["skipping malformed telemetry records"]);
  });
});
