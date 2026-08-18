// Disables the post-invoke span-ingestion wait so the replay returns immediately.
process.env.SIMULATE_INGESTION_WAIT_MS = "0";

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GetAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore-control";
import { InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore";
import { EvalClient } from "../../eval";
import type { AwsClients, CoreFetch } from "../../types";
import type { InvokedSession } from "../../../handlers/eval/types";

// End-to-end coverage of EvalClient.invokeDataset over a fake AWS layer. Exercising the real
// method also exercises its consumers — DatasetLoader, the Example classes, runExamples,
// renderJsonTemplate, and invokeRuntime's IAM path — so those need no separate unit tests.

const OPTIONS = { region: "us-west-2" };
const RUNTIME_ARN = "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/rt-1";
const row = (o: object) => JSON.stringify(o);

async function* replyBytes(text: string): AsyncGenerator<Uint8Array> {
  yield new TextEncoder().encode(text);
}

// A fake AWS layer: control resolves the runtime, data answers each invoke. Records every
// payload it was asked to send, and per `opts` can fail or delay specific invokes.
function fakeClients(opts: { fail?: (payload: string) => boolean; delayMs?: number } = {}): {
  clients: AwsClients;
  payloads: string[];
  peak: () => number;
} {
  const payloads: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const send = async (command: unknown) => {
    if (command instanceof GetAgentRuntimeCommand) return { agentRuntimeArn: RUNTIME_ARN };
    if (command instanceof InvokeAgentRuntimeCommand) {
      const payload = new TextDecoder().decode(command.input.payload as Uint8Array);
      payloads.push(payload);
      if (opts.fail?.(payload)) throw new Error(`invoke failed for ${payload}`);
      inFlight++;
      peak = Math.max(peak, inFlight);
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      inFlight--;
      return { statusCode: 200, contentType: "application/json", response: replyBytes("ok") };
    }
    throw new Error(
      `unexpected command: ${(command as { constructor: { name: string } }).constructor.name}`,
    );
  };
  const client = { send } as never;
  return {
    clients: { control: () => client, data: () => client, iam: () => client, logs: () => client },
    payloads,
    peak: () => peak,
  };
}

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function datasetFile(jsonl: string): string {
  const dir = mkdtempSync(join(tmpdir(), "agentcore-invoke-ds-"));
  dirs.push(dir);
  const path = join(dir, "dataset.jsonl");
  writeFileSync(path, jsonl);
  return path;
}

function invokeDataset(jsonl: string, clients: AwsClients) {
  const fetch = (() => {
    throw new Error("fetch is only used on the CUSTOM_JWT path, which these tests do not exercise");
  }) as unknown as CoreFetch;
  return new EvalClient(clients, fetch).invokeDataset(
    { runtimeId: "rt-1", payloadTemplate: '{"prompt":"{input}"}', dataset: datasetFile(jsonl) },
    OPTIONS,
  );
}

// sessionId is a fresh UUID per example, so pin it to compare shapes; sort so completion
// order (which is nondeterministic under concurrency) doesn't churn the golden.
function normalize(sessions: InvokedSession[]) {
  return [...sessions]
    .sort((a, b) => a.exampleId.localeCompare(b.exampleId))
    .map((s) => ({ ...s, sessionId: "<uuid>" }));
}

const GOLDEN_FIXTURES: { name: string; jsonl: string }[] = [
  {
    name: "single turn, no ground truth",
    jsonl: row({ example_id: "e1", turns: [{ input: "hi" }] }),
  },
  {
    name: "multi-turn, sparse expectation keeps its turn position",
    jsonl: row({
      example_id: "e2",
      turns: [{ input: "t1" }, { input: "t2" }, { input: "t3", expected_response: "42" }],
    }),
  },
  {
    name: "empty expected_response is treated as no expectation",
    jsonl: row({ example_id: "e3", turns: [{ input: "t1", expected_response: "" }] }),
  },
  {
    name: "assertions + trajectory + sparse turns (full inline shape)",
    jsonl: row({
      example_id: "orders-1",
      turns: [
        { input: "I want a refund" },
        { input: "order 123", expected_response: "Refund started" },
      ],
      assertions: ["stays polite", "does not promise a date"],
      expected_trajectory: ["refund_lookup", "refund_create"],
    }),
  },
  {
    name: "empty assertions/trajectory arrays are omitted",
    jsonl: row({
      example_id: "e4",
      turns: [{ input: "t1", expected_response: "r1" }],
      assertions: [],
      expected_trajectory: [],
    }),
  },
  {
    name: "legacy scenario_id fallback + unicode id",
    jsonl: row({ scenario_id: "café-日本-🎉", turns: [{ input: "1", expected_response: "ok" }] }),
  },
  {
    name: "tolerates blank lines and CRLF between multiple rows",
    jsonl:
      row({ example_id: "a", turns: [{ input: "1" }] }) +
      "\r\n\r\n" +
      row({ example_id: "b", turns: [{ input: "2", expected_response: "ok" }] }) +
      "\r\n",
  },
];

const THROW_FIXTURES: { name: string; jsonl: string; error: RegExp }[] = [
  {
    name: "both turns and actor_profile",
    jsonl: row({ example_id: "x", turns: [{ input: "a" }], actor_profile: {} }),
    error: /both 'turns' and 'actor_profile'/,
  },
  {
    name: "neither turns nor actor_profile",
    jsonl: row({ example_id: "x" }),
    error: /neither 'turns' nor 'actor_profile'/,
  },
  {
    name: "simulated example not supported yet",
    jsonl: row({ example_id: "x", actor_profile: { goal: "g" } }),
    error: /simulated example/,
  },
  {
    name: "duplicate example ids",
    jsonl: [
      row({ example_id: "a", turns: [{ input: "1" }] }),
      row({ example_id: "a", turns: [{ input: "2" }] }),
    ].join("\n"),
    error: /duplicate example_id: "a"/,
  },
  {
    name: "missing example id",
    jsonl: row({ turns: [{ input: "hi" }] }),
    error: /missing 'example_id'/,
  },
  { name: "invalid JSON line", jsonl: "{not json", error: /not valid JSON/ },
  { name: "non-object row (null)", jsonl: "null", error: /not a JSON object/ },
  { name: "empty dataset", jsonl: "\n  \n", error: /no examples/ },
  { name: "empty turns array", jsonl: row({ example_id: "x", turns: [] }), error: /has no turns/ },
  {
    name: "non-object turn entry",
    jsonl: row({ example_id: "x", turns: [null] }),
    error: /turn 1 is not an object/,
  },
];

describe("EvalClient.invokeDataset", () => {
  // One golden block over representative datasets: locks the created sessions + the exact
  // inline ground-truth shape handed to the grader, across every ground-truth variation.
  test("golden: sessions + ground truth over representative datasets", async () => {
    const results: Record<string, unknown> = {};
    for (const f of GOLDEN_FIXTURES) {
      const r = await invokeDataset(f.jsonl, fakeClients().clients);
      results[f.name] = { invoked: r.invoked, failed: r.failed, sessions: normalize(r.sessions) };
    }
    expect(results).toMatchSnapshot();
  });

  test.each(THROW_FIXTURES)("rejects and invokes nothing: $name", async ({ jsonl, error }) => {
    const { clients, payloads } = fakeClients();
    await expect(invokeDataset(jsonl, clients)).rejects.toThrow(error);
    expect(payloads).toEqual([]);
  });

  test("a failed invoke is counted and dropped; the rest still run", async () => {
    const jsonl = [
      row({ example_id: "ok1", turns: [{ input: "hi" }] }),
      row({ example_id: "bad", turns: [{ input: "FAIL" }] }),
      row({ example_id: "ok2", turns: [{ input: "yo" }] }),
    ].join("\n");
    const r = await invokeDataset(jsonl, fakeClients({ fail: (p) => p.includes("FAIL") }).clients);
    expect(r.invoked).toBe(2);
    expect(r.failed).toBe(1);
    expect(r.sessions.map((s) => s.exampleId).sort()).toEqual(["ok1", "ok2"]);
    expect(r.firstError?.message).toMatch(/invoke failed/);
  });

  test("invokes each turn exactly once across all examples, rendered through the template", async () => {
    const jsonl = [
      row({ example_id: "a", turns: [{ input: "a1" }, { input: "a2" }] }),
      row({ example_id: "b", turns: [{ input: "b1" }] }),
    ].join("\n");
    const { clients, payloads } = fakeClients();
    await invokeDataset(jsonl, clients);
    expect(payloads.sort()).toEqual(
      ['{"prompt":"a1"}', '{"prompt":"a2"}', '{"prompt":"b1"}'].sort(),
    );
  });

  test("runs examples concurrently but never past the pool bound", async () => {
    const jsonl = Array.from({ length: 12 }, (_, i) =>
      row({ example_id: `e${i}`, turns: [{ input: `p${i}` }] }),
    ).join("\n");
    const { clients, peak } = fakeClients({ delayMs: 5 });
    await invokeDataset(jsonl, clients);
    expect(peak()).toBeLessThanOrEqual(5); // runExamples default concurrency
    expect(peak()).toBeGreaterThanOrEqual(2); // proves it did not run serially
  });
});
