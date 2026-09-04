import { describe, expect, test } from "bun:test";
import type { ProgressEvent } from "../../tui/progress";
import { executePlan, PlanValidationError, validatePlan, type ExecutePlanOptions } from "./plan";
import type { Plan, Step, StepStatus } from "./types";

// Fake steps read from a scripted sequence of statuses (the last one repeats)
// and record every call, so a test asserts what the engine did — which calls,
// in what order — rather than how it scheduled them.
type FakeStep = Step & { doCalls: number; statusCalls: number };

function fakeStep(
  name: string,
  statuses: StepStatus[],
  log: string[],
  options: { next?: Step[]; onDo?: () => void; statusError?: Error } = {},
): FakeStep {
  const step: FakeStep = {
    name,
    doCalls: 0,
    statusCalls: 0,
    next: options.next,
    async do() {
      step.doCalls++;
      log.push(`${name}:do`);
      options.onDo?.();
    },
    async status() {
      if (options.statusError) throw options.statusError;
      const status = statuses[Math.min(step.statusCalls, statuses.length - 1)]!;
      step.statusCalls++;
      log.push(`${name}:${status}`);
      return status;
    },
  };
  return step;
}

const instant: ExecutePlanOptions = { sleep: async () => {}, pollIntervalMs: 0 };

async function run(plan: Plan, options: ExecutePlanOptions = instant): Promise<ProgressEvent[]> {
  const events: ProgressEvent[] = [];
  for await (const event of executePlan(plan, options)) events.push(event);
  return events;
}

async function failureOf(plan: Plan, options: ExecutePlanOptions = instant): Promise<Error> {
  try {
    await run(plan, options);
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the plan to fail");
}

describe("executePlan", () => {
  test("drives a step from NOT_STARTED through WAITING to SUCCESSFUL", async () => {
    const log: string[] = [];
    const step = fakeStep("create", ["NOT_STARTED", "WAITING", "WAITING", "SUCCESSFUL"], log);

    const events = await run({ name: "p", steps: [step] });

    expect(step.doCalls).toBe(1);
    expect(log).toEqual([
      "create:NOT_STARTED",
      "create:do",
      "create:WAITING",
      "create:WAITING",
      "create:SUCCESSFUL",
    ]);
    expect(events).toEqual([
      { type: "step", message: "create" },
      { type: "output", line: "create: issuing" },
      { type: "output", line: "create: issued" },
      { type: "output", line: "create: waiting" },
      { type: "output", line: "create: satisfied" },
    ]);
  });

  test("never calls do on a step that already reads SUCCESSFUL", async () => {
    const log: string[] = [];
    const step = fakeStep("existing", ["SUCCESSFUL"], log);

    const events = await run({ name: "p", steps: [step] });

    expect(step.doCalls).toBe(0);
    expect(events).toEqual([
      { type: "step", message: "existing" },
      { type: "output", line: "existing: satisfied" },
    ]);
  });

  test("runs roots concurrently", async () => {
    const log: string[] = [];
    // Each root needs two polls; with sequential execution the log would show
    // one step finish before the other starts.
    const a = fakeStep("a", ["NOT_STARTED", "SUCCESSFUL"], log);
    const b = fakeStep("b", ["NOT_STARTED", "SUCCESSFUL"], log);

    await run({ name: "p", steps: [a, b] });

    expect(log.indexOf("b:NOT_STARTED")).toBeLessThan(log.indexOf("a:SUCCESSFUL"));
  });

  test("a joined step runs exactly once, after its last parent succeeds", async () => {
    const log: string[] = [];
    const d = fakeStep("d", ["NOT_STARTED", "SUCCESSFUL"], log);
    // b finishes fast; c needs several polls so the join has to wait for it.
    const b = fakeStep("b", ["SUCCESSFUL"], log, { next: [d] });
    const c = fakeStep("c", ["NOT_STARTED", "WAITING", "WAITING", "SUCCESSFUL"], log, {
      next: [d],
    });
    const a = fakeStep("a", ["NOT_STARTED", "SUCCESSFUL"], log, { next: [b, c] });

    await run({ name: "diamond", steps: [a] });

    expect(d.doCalls).toBe(1);
    expect(log.indexOf("d:NOT_STARTED")).toBeGreaterThan(log.indexOf("b:SUCCESSFUL"));
    expect(log.indexOf("d:NOT_STARTED")).toBeGreaterThan(log.indexOf("c:SUCCESSFUL"));
    expect(log.indexOf("b:SUCCESSFUL")).toBeGreaterThan(log.indexOf("a:SUCCESSFUL"));
  });

  test("a failure lets running steps finish but schedules nothing new", async () => {
    const log: string[] = [];
    const d = fakeStep("d", ["NOT_STARTED", "SUCCESSFUL"], log);
    const b = fakeStep("b", ["NOT_STARTED", "FAILED"], log, { next: [d] });
    const c = fakeStep("c", ["NOT_STARTED", "WAITING", "WAITING", "SUCCESSFUL"], log, {
      next: [d],
    });

    const error = await failureOf({ name: "p", steps: [b, c] });

    expect(error.message).toContain("Plan 'p' completed with an error");
    expect(error.message).toContain("b: the step reported FAILED");
    // c was in flight when b failed and ran to completion...
    expect(log).toContain("c:SUCCESSFUL");
    // ...but d, whose parents both finished, was never started.
    expect(d.statusCalls).toBe(0);
    expect(d.doCalls).toBe(0);
  });

  test("lists every failed step in the error", async () => {
    const log: string[] = [];
    const a = fakeStep("a", ["FAILED"], log);
    const b = fakeStep("b", ["NOT_STARTED"], log, { statusError: new Error("boom") });

    const error = await failureOf({ name: "p", steps: [a, b] });

    expect(error.message).toContain("completed with errors");
    expect(error.message).toContain("a: the step reported FAILED");
    expect(error.message).toContain("b: boom");
  });

  test("gives up on a step that keeps reading NOT_STARTED after do", async () => {
    const log: string[] = [];
    const step = fakeStep("stuck", ["NOT_STARTED"], log);

    const error = await failureOf(
      { name: "p", steps: [step] },
      { ...instant, maxNotStartedAttempts: 2 },
    );

    expect(step.doCalls).toBe(2);
    expect(error.message).toContain("expected step 'stuck' to have started after 2 attempts");
  });

  test("a step that throws from do fails with that error", async () => {
    const log: string[] = [];
    const step = fakeStep("boom", ["NOT_STARTED"], log, {
      onDo: () => {
        throw new Error("CreateHarness denied");
      },
    });

    const error = await failureOf({ name: "p", steps: [step] });

    expect(error.message).toContain("boom: CreateHarness denied");
    expect(error.cause).toBeInstanceOf(Error);
  });

  test("a step that throws from status fails with that error", async () => {
    const log: string[] = [];
    const step = fakeStep("probe", ["NOT_STARTED"], log, {
      statusError: new Error("harness is CREATE_FAILED: bad role"),
    });

    const error = await failureOf({ name: "p", steps: [step] });

    expect(error.message).toContain("probe: harness is CREATE_FAILED: bad role");
    expect(step.doCalls).toBe(0);
  });

  test("times out a step that waits too long", async () => {
    const log: string[] = [];
    const step = fakeStep("slow", ["NOT_STARTED", "WAITING"], log);
    let clock = 0;

    const error = await failureOf(
      { name: "p", steps: [step] },
      {
        pollIntervalMs: 1_000,
        stepTimeoutMs: 2_500,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      },
    );

    expect(error.message).toContain("timed out after 3s waiting for step 'slow'");
  });

  test("polls WAITING at the configured interval through the injected sleep", async () => {
    const log: string[] = [];
    const slept: number[] = [];
    const step = fakeStep("poll", ["WAITING", "WAITING", "SUCCESSFUL"], log);

    await run(
      { name: "p", steps: [step] },
      {
        pollIntervalMs: 250,
        sleep: async (ms) => {
          slept.push(ms);
        },
      },
    );

    expect(slept).toEqual([250, 250]);
  });

  test("a step reachable from two roots is released once per root", async () => {
    const log: string[] = [];
    const shared = fakeStep("shared", ["NOT_STARTED", "SUCCESSFUL"], log);
    const a = fakeStep("a", ["SUCCESSFUL"], log, { next: [shared] });
    const b = fakeStep("b", ["NOT_STARTED", "WAITING", "SUCCESSFUL"], log, { next: [shared] });

    await run({ name: "p", steps: [a, b] });

    expect(shared.doCalls).toBe(1);
    expect(log.indexOf("shared:NOT_STARTED")).toBeGreaterThan(log.indexOf("b:SUCCESSFUL"));
  });
});

describe("validatePlan", () => {
  const ok = async () => {};
  const successful = async (): Promise<StepStatus> => "SUCCESSFUL";

  test("rejects an empty plan", () => {
    expect(() => validatePlan({ name: "empty", steps: [] })).toThrow(PlanValidationError);
    expect(() => validatePlan({ name: "empty", steps: [] })).toThrow("has no steps");
  });

  test("rejects two steps with the same name", () => {
    const plan: Plan = {
      name: "dup",
      steps: [
        { name: "x", do: ok, status: successful },
        { name: "x", do: ok, status: successful },
      ],
    };
    expect(() => validatePlan(plan)).toThrow("two steps named 'x'");
  });

  test("rejects a cycle and names it", () => {
    const a: Step = { name: "a", do: ok, status: successful };
    const b: Step = { name: "b", do: ok, status: successful, next: [a] };
    a.next = [b];
    expect(() => validatePlan({ name: "loop", steps: [a] })).toThrow("cycle: a -> b -> a");
  });

  test("accepts a diamond, which is not a cycle", () => {
    const d: Step = { name: "d", do: ok, status: successful };
    const b: Step = { name: "b", do: ok, status: successful, next: [d] };
    const c: Step = { name: "c", do: ok, status: successful, next: [d] };
    const a: Step = { name: "a", do: ok, status: successful, next: [b, c] };
    expect(() => validatePlan({ name: "diamond", steps: [a] })).not.toThrow();
  });

  test("executePlan validates before starting any step", async () => {
    const log: string[] = [];
    const step = fakeStep("x", ["NOT_STARTED"], log);
    const twin = fakeStep("x", ["NOT_STARTED"], log);
    await expect(run({ name: "dup", steps: [step, twin] })).rejects.toThrow("two steps named 'x'");
    expect(step.statusCalls).toBe(0);
    expect(twin.statusCalls).toBe(0);
  });
});
