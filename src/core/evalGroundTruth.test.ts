import { test, expect, describe } from "bun:test";
import {
  EvaluateCommand,
  StartBatchEvaluationCommand,
  type EvaluationReferenceInput,
  type SessionMetadataShape,
} from "@aws-sdk/client-bedrock-agentcore";
import { GetEvaluatorCommand } from "@aws-sdk/client-bedrock-agentcore-control";
import { EvalClient } from "./eval";
import { InputValidationError } from "../errors";
import type { Logger } from "../logging";
import type { AwsClients } from "./types";
import type { SessionTrace, SessionSourceValue } from "../handlers/eval/types";

const OPTIONS = { region: "us-west-2" };
const TRACE: SessionTrace = {
  sessionId: "session-1",
  spans: [{ traceId: "trace-1", spanId: "span-1" }],
  traceIds: ["trace-1"],
  toolCallSpanIds: [],
};

function makeClient() {
  const evaluateInputs: unknown[] = [];
  const batchInputs: unknown[] = [];
  const warnings: string[] = [];
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (...messages) => warnings.push(messages.join(" ")),
    error: () => {},
    child: () => logger,
  };
  const clients = {
    control: () => ({
      send: async (command: unknown) => {
        if (command instanceof GetEvaluatorCommand) {
          return { evaluatorId: "evaluator-1", level: "SESSION" };
        }
        throw new Error(`unexpected control command: ${(command as object).constructor.name}`);
      },
    }),
    data: () => ({
      send: async (command: unknown) => {
        if (command instanceof EvaluateCommand) {
          evaluateInputs.push(command.input);
          return { evaluationResults: [] };
        }
        if (command instanceof StartBatchEvaluationCommand) {
          batchInputs.push(command.input);
          return { batchEvaluationId: "batch-1" };
        }
        throw new Error(`unexpected data command: ${(command as object).constructor.name}`);
      },
    }),
  } as unknown as AwsClients;
  return {
    client: new EvalClient(clients, undefined, logger),
    evaluateInputs,
    batchInputs,
    warnings,
  };
}

describe("on-demand evaluation ground truth", () => {
  test("rejects a reference without context.spanContext.sessionId before evaluating", async () => {
    const { client, evaluateInputs } = makeClient();
    const reference = {
      context: { spanContext: { traceId: "trace-1" } },
      expectedResponse: { text: "expected" },
    } as unknown as EvaluationReferenceInput;

    const error = await client
      .evaluate(
        { traces: [TRACE], evaluatorIds: ["evaluator-1"], groundTruth: [reference] },
        OPTIONS,
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(InputValidationError);
    expect(error).toMatchObject({
      message: expect.stringMatching(/entry 0 is missing context\.spanContext\.sessionId/),
    });
    expect(evaluateInputs).toHaveLength(0);
  });

  test("warns when a reference session does not have an evaluation target", async () => {
    const { client, evaluateInputs, warnings } = makeClient();
    const reference: EvaluationReferenceInput = {
      context: { spanContext: { sessionId: "other-session" } },
      expectedResponse: { text: "expected" },
    };

    await client.evaluate(
      { traces: [TRACE], evaluatorIds: ["evaluator-1"], groundTruth: [reference] },
      OPTIONS,
    );

    expect(evaluateInputs).toHaveLength(1);
    expect(evaluateInputs[0]).toMatchObject({ evaluationReferenceInputs: undefined });
    expect(warnings).toEqual([
      "ground-truth entries reference sessions not evaluated: other-session",
    ]);
  });

  test("attaches matching references to their session evaluation", async () => {
    const { client, evaluateInputs, warnings } = makeClient();
    const reference: EvaluationReferenceInput = {
      context: { spanContext: { sessionId: "session-1" } },
      expectedResponse: { text: "expected" },
    };

    await client.evaluate(
      { traces: [TRACE], evaluatorIds: ["evaluator-1"], groundTruth: [reference] },
      OPTIONS,
    );

    expect(evaluateInputs[0]).toMatchObject({ evaluationReferenceInputs: [reference] });
    expect(warnings).toEqual([]);
  });
});

describe("batch evaluation ground truth", () => {
  test("rejects session metadata without sessionId before starting the job", async () => {
    const { client, batchInputs } = makeClient();
    const source = {
      origin: "raw",
      dataSourceConfig: {},
    } as unknown as SessionSourceValue;
    const groundTruth = [
      { groundTruth: { inline: { turns: [] } } },
    ] as unknown as SessionMetadataShape[];

    await expect(
      client.startBatchEvaluation(
        { name: "eval-1", evaluatorIds: ["evaluator-1"], source, groundTruth },
        OPTIONS,
      ),
    ).rejects.toThrow(/entry 0 is missing sessionId/);
    expect(batchInputs).toHaveLength(0);
  });
});
