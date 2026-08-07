import { test, expect } from "bun:test";
import type { CloudWatchLogsClient, OutputLogEvent } from "@aws-sdk/client-cloudwatch-logs";
import { createSilentLogger } from "../testing";
import {
  isTerminalStatus,
  parseEvaluationLogEvent,
  readEvaluationResults,
} from "./batchEvaluationResults";

// fakeLogs returns a CloudWatchLogsClient that serves `events` as a single page,
// then signals exhaustion by echoing the same nextForwardToken on the next call —
// exactly how GetLogEvents ends pagination. Records the tokens it was called with.
function fakeLogs(events: OutputLogEvent[]): CloudWatchLogsClient {
  let served = false;
  return {
    send: async () => {
      if (!served) {
        served = true;
        return { events, nextForwardToken: "t-end" };
      }
      return { events: [], nextForwardToken: "t-end" }; // token unchanged → done
    },
  } as unknown as CloudWatchLogsClient;
}

// fakePagedLogs serves each element of `pages` on successive calls, advancing the
// forward token per page and repeating the last token once to end. Captures every
// nextToken the caller sent, so a test can assert the loop paged correctly.
function fakePagedLogs(pages: OutputLogEvent[][]): {
  client: CloudWatchLogsClient;
  tokens: (string | undefined)[];
} {
  const tokens: (string | undefined)[] = [];
  let call = 0;
  const client = {
    send: async (command: { input: { nextToken?: string } }) => {
      tokens.push(command.input.nextToken);
      const i = call++;
      if (i < pages.length) return { events: pages[i], nextForwardToken: `t-${i}` };
      return { events: [], nextForwardToken: `t-${pages.length - 1}` }; // repeat last → done
    },
  } as unknown as CloudWatchLogsClient;
  return { client, tokens };
}

// A realistic stream shaped after the real `gen_ai.evaluation.result` records
// (see the recorded fixture below): the level is
// attributes["aws.bedrock_agentcore.evaluation_level"] (Title-case), session.id
// sits under attributes, and the trace id is the top-level camelCase `traceId`.
// One SESSION-level and one TRACE-level record, plus a non-JSON control line.
const EVENTS: OutputLogEvent[] = [
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
  const results = await readEvaluationResults(fakeLogs(EVENTS), "lg", "ls", createSilentLogger());

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

test("readEvaluationResults follows pagination until the forward token stops advancing", async () => {
  const page = (name: string): OutputLogEvent => ({
    message: JSON.stringify({
      attributes: {
        "gen_ai.evaluation.name": name,
        "aws.bedrock_agentcore.evaluation_level": "Trace",
        "session.id": "s1",
      },
    }),
  });
  const { client, tokens } = fakePagedLogs([
    [page("Builtin.Correctness")],
    [page("Builtin.Helpfulness")],
    [page("Builtin.Faithfulness")],
  ]);

  const results = await readEvaluationResults(client, "lg", "ls", createSilentLogger());

  // All three pages' records are collected.
  expect(results.map((r) => r.evaluatorId)).toEqual([
    "Builtin.Correctness",
    "Builtin.Helpfulness",
    "Builtin.Faithfulness",
  ]);
  // First call has no token; later calls carry the prior page's forward token; a
  // final call detects the repeated token and stops.
  expect(tokens).toEqual([undefined, "t-0", "t-1", "t-2"]);
});

// Real-log-shape validation lives in the fixture-backed command-flow test
// (batch-evaluation.fixture.test.tsx), where RECORD=1 captures a live GetLogEvents
// response and matchGolden pins the parsed output. This file stays a pure unit
// test over inline synthetic events, matching the rest of src/core.

test("readEvaluationResults skips lines without an evaluation name", async () => {
  const results = await readEvaluationResults(
    fakeLogs([
      { message: JSON.stringify({ attributes: { "some.other.metric": 1 } }) },
      { message: "" },
      { message: undefined },
    ]),
    "lg",
    "ls",
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
