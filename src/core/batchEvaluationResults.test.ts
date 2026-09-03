import { test, expect } from "bun:test";
import { createSilentLogger } from "../testing";
import {
  isTerminalStatus,
  parseEvaluationLogEvent,
  readEvaluationResults,
} from "./batchEvaluationResults";
import type { CloudWatchLogEvent } from "./observability/index";

async function* events(
  messages: ({ message?: string } | string)[],
): AsyncGenerator<CloudWatchLogEvent> {
  for (const item of messages) {
    yield {
      timestamp: new Date(0),
      message: typeof item === "string" ? item : (item.message ?? ""),
    };
  }
}

// A realistic stream shaped after the real `gen_ai.evaluation.result` records
// (see the recorded fixture below): the level is
// attributes["aws.bedrock_agentcore.evaluation_level"] (Title-case), session.id
// sits under attributes, and the trace id is the top-level camelCase `traceId`.
// One SESSION-level and one TRACE-level record, plus a non-JSON control line.
const EVENTS = [
  {
    message: JSON.stringify({
      attributes: {
        "gen_ai.evaluation.name": "Builtin.Helpfulness",
        "aws.bedrock_agentcore.evaluation_level": "Session",
        "session.id": "session-orders-123",
        "gen_ai.evaluation.score.value": 5,
        "gen_ai.evaluation.score.label": "helpful",
        "gen_ai.evaluation.explanation": "Directly answered with tracking detail.",
      },
    }),
  },
  {
    message: JSON.stringify({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      attributes: {
        "gen_ai.evaluation.name": "Builtin.Faithfulness",
        "aws.bedrock_agentcore.evaluation_level": "Trace",
        "session.id": "session-orders-123",
        "gen_ai.evaluation.score.value": 4,
        "gen_ai.evaluation.score.label": "faithful",
        "gen_ai.evaluation.explanation": "Grounded in the tool result.",
      },
    }),
  },
  { message: "AWS log control line, not JSON" },
];

test("isTerminalStatus recognizes the terminal arm only", () => {
  for (const s of ["COMPLETED", "COMPLETED_WITH_ERRORS", "FAILED", "STOPPED"]) {
    expect(isTerminalStatus(s)).toBe(true);
  }
  for (const s of ["IN_PROGRESS", "PENDING", "STOPPING", "DELETING", undefined]) {
    expect(isTerminalStatus(s)).toBe(false);
  }
});

test("readEvaluationResults keeps level + scope so sessions and traces are distinguishable", async () => {
  const results = await readEvaluationResults(events(EVENTS), createSilentLogger());

  // The non-JSON control line is skipped; the two evaluation records parse.
  expect(results).toHaveLength(2);
  expect(results[0]).toMatchObject({
    evaluatorId: "Builtin.Helpfulness",
    level: "Session",
    sessionId: "session-orders-123",
    score: 5,
    label: "helpful",
  });
  expect(results[0]?.traceId).toBeUndefined();
  expect(results[1]).toMatchObject({
    evaluatorId: "Builtin.Faithfulness",
    level: "Trace",
    sessionId: "session-orders-123",
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  });
  expect(results.map((r) => r.level)).toEqual(["Session", "Trace"]);
});

// Real-log-shape validation lives in the fixture-backed command-flow test
// (batch-evaluation.fixture.test.tsx), where RECORD=1 captures a live GetLogEvents
// response and matchGolden pins the parsed output. This file stays a pure unit
// test over inline synthetic events, matching the rest of src/core.

test("readEvaluationResults skips lines without an evaluation name", async () => {
  const results = await readEvaluationResults(
    events([
      { message: JSON.stringify({ attributes: { "some.other.metric": 1 } }) },
      { message: "" },
      { message: undefined },
    ]),
    createSilentLogger(),
  );
  expect(results).toEqual([]);
});

test("parseEvaluationLogEvent warns on and skips an unparseable line", () => {
  const warnings: string[] = [];
  const logger = createSilentLogger();
  logger.warn = (...msgs: string[]) => warnings.push(msgs.join(" "));

  expect(parseEvaluationLogEvent("AWS log control line, not JSON", logger)).toBeNull();
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("unparseable");
});
