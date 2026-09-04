import { AgentCoreCLIError, ProjectStateError } from "../../errors/errors";
import { ERROR_SOURCE } from "../../errors";
import { AsyncChannel } from "../../io";
import type { Logger } from "../../logging";
import type { ProgressEvent } from "../../tui/progress";
import type { Plan, Step, StepStatus } from "./types";

// A port of lightpress's plan engine: a parallel breadth-first walk of a
// polytree of steps. Every root starts at once; a step with several parents
// runs only after its last parent succeeds; after a step succeeds its children
// are queued. Each step loops on its own read call — issue the mutation when the
// world says NOT_STARTED, poll while WAITING, finish on SUCCESSFUL — so the plan
// as a whole is idempotent and resumable without any bookkeeping of its own.

export type ExecutePlanOptions = {
  /** Injected so tests run with an instant sleep and deterministic ordering. */
  sleep?: (ms: number) => Promise<void>;
  /** How long a WAITING step pauses between polls. */
  pollIntervalMs?: number;
  /**
   * How many times a step may report NOT_STARTED before the engine gives up on
   * it: the n-th NOT_STARTED calls `do` when n is at or below this cap. Matches
   * lightpress, where a mutation that leaves the world unchanged is a failure.
   */
  maxNotStartedAttempts?: number;
  /** Longest a step may sit in WAITING before it fails. */
  stepTimeoutMs?: number;
  /** Clock for the timeout, injected so tests can advance it. */
  now?: () => number;
  logger?: Logger;
};

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_MAX_NOT_STARTED_ATTEMPTS = 2;
const DEFAULT_STEP_TIMEOUT_MS = 15 * 60 * 1_000;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A plan that cannot be executed as written: a programming error, not a user one. */
export class PlanValidationError extends AgentCoreCLIError {
  constructor(message: string) {
    super(message, { source: ERROR_SOURCE.INTERNAL });
  }
}

/**
 * Rejects a plan the walk could not run to completion: no roots, two steps
 * sharing a name (progress lines and errors would be ambiguous), or a cycle
 * (an in-degree that never reaches zero). The cycle check is a DFS with the
 * usual white/grey/black colouring rather than lightpress's visit-count
 * heuristic, so a diamond is accepted and a real cycle is named.
 */
export function validatePlan(plan: Plan): void {
  if (plan.steps.length === 0) {
    throw new PlanValidationError(`plan '${plan.name}' has no steps`);
  }

  const namesSeen = new Map<string, Step>();
  const visiting = new Set<Step>();
  const done = new Set<Step>();

  const visit = (step: Step, path: string[]): void => {
    const owner = namesSeen.get(step.name);
    if (owner && owner !== step) {
      throw new PlanValidationError(`plan '${plan.name}' has two steps named '${step.name}'`);
    }
    namesSeen.set(step.name, step);

    if (done.has(step)) return;
    if (visiting.has(step)) {
      throw new PlanValidationError(
        `plan '${plan.name}' has a cycle: ${[...path, step.name].join(" -> ")}`,
      );
    }
    visiting.add(step);
    for (const child of step.next ?? []) visit(child, [...path, step.name]);
    visiting.delete(step);
    done.add(step);
  };

  for (const root of plan.steps) visit(root, []);
}

/** How many times a step has to be released before it may start. */
function countInDegrees(plan: Plan): Map<Step, number> {
  const remaining = new Map<Step, number>();
  const bump = (step: Step) => remaining.set(step, (remaining.get(step) ?? 0) + 1);
  const seen = new Set<Step>();
  const walk = (step: Step) => {
    if (seen.has(step)) return;
    seen.add(step);
    for (const child of step.next ?? []) {
      bump(child);
      walk(child);
    }
  };
  for (const root of plan.steps) {
    bump(root);
    walk(root);
  }
  return remaining;
}

class StepFailure extends Error {
  constructor(
    readonly step: Step,
    readonly reason: unknown,
  ) {
    super(`${step.name}: ${(reason as Error)?.message ?? String(reason)}`, { cause: reason });
  }
}

type StepRunner = {
  emit: (event: ProgressEvent) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  pollIntervalMs: number;
  maxNotStartedAttempts: number;
  stepTimeoutMs: number;
  logger?: Logger;
};

/**
 * Drives one step to SUCCESSFUL or throws. The loop is lightpress's: read,
 * then act on the reading. `do` is issued only from a NOT_STARTED reading and
 * at most `maxNotStartedAttempts` times; a mutation that keeps reading as
 * NOT_STARTED is reported rather than retried forever.
 */
async function runStep(step: Step, runner: StepRunner): Promise<void> {
  const line = (text: string) => runner.emit({ type: "output", line: `${step.name}: ${text}` });
  runner.emit({ type: "step", message: step.name });
  runner.logger?.child({ step: step.name }).debug("step started");

  const startedAt = runner.now();
  let notStarted = 0;
  let waiting = false;
  for (;;) {
    const status: StepStatus = await step.status();
    switch (status) {
      case "SUCCESSFUL":
        line("satisfied");
        runner.logger?.child({ step: step.name }).debug("step succeeded");
        return;
      case "FAILED":
        throw new Error("the step reported FAILED");
      case "NOT_STARTED": {
        notStarted++;
        if (notStarted > runner.maxNotStartedAttempts) {
          throw new Error(
            `expected step '${step.name}' to have started after ${runner.maxNotStartedAttempts} ` +
              `attempt${runner.maxNotStartedAttempts === 1 ? "" : "s"}, but it still reports NOT_STARTED`,
          );
        }
        line(notStarted === 1 ? "issuing" : `issuing again (attempt ${notStarted})`);
        await step.do(line);
        line("issued");
        waiting = false;
        break;
      }
      case "WAITING": {
        const elapsed = runner.now() - startedAt;
        if (elapsed > runner.stepTimeoutMs) {
          throw new Error(
            `timed out after ${Math.round(elapsed / 1000)}s waiting for step '${step.name}'`,
          );
        }
        // One line on entering WAITING and then a quiet poll: the progress tail
        // shows the step is alive without scrolling a line per poll.
        if (!waiting) line("waiting");
        waiting = true;
        break;
      }
    }
    await runner.sleep(runner.pollIntervalMs);
  }
}

/**
 * Executes `plan`, yielding progress as it goes. Several steps may run at once,
 * so every output line is prefixed with its step name; the linear progress
 * renderer attributes lines to the most recently started step, which is
 * readable enough for the small plans a deploy builds.
 *
 * On the first failure the steps already running finish, but nothing new is
 * scheduled; the generator then throws a ProjectStateError that lists every
 * failed step with its error.
 */
export async function* executePlan(
  plan: Plan,
  options: ExecutePlanOptions = {},
): AsyncGenerator<ProgressEvent, void> {
  validatePlan(plan);

  const events = new AsyncChannel<ProgressEvent>();
  const walk = walkPlan(plan, options, (event) => events.push(event)).finally(() => events.close());
  // The rejection is consumed by the await below; this handler only keeps the
  // window between the failure and the channel draining from being reported as
  // an unhandled rejection.
  walk.catch(() => {});
  for await (const event of events) yield event;
  await walk;
}

async function walkPlan(
  plan: Plan,
  options: ExecutePlanOptions,
  emit: (event: ProgressEvent) => void,
): Promise<void> {
  const runner: StepRunner = {
    emit,
    sleep: options.sleep ?? defaultSleep,
    now: options.now ?? Date.now,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    maxNotStartedAttempts: options.maxNotStartedAttempts ?? DEFAULT_MAX_NOT_STARTED_ATTEMPTS,
    stepTimeoutMs: options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
    logger: options.logger,
  };
  options.logger?.child({ plan: plan.name }).debug("plan started");

  const remaining = countInDegrees(plan);
  const running = new Set<Promise<void>>();
  const failures: StepFailure[] = [];

  // release counts a parent's success (or the initial root release) against
  // the step's in-degree and starts it when the last one lands.
  const release = (step: Step): void => {
    const left = (remaining.get(step) ?? 1) - 1;
    remaining.set(step, left);
    if (left > 0) return;
    start(step);
  };

  const start = (step: Step): void => {
    const run = runStep(step, runner)
      .then(() => {
        // Children are queued only while the plan is healthy: after a failure
        // in-flight steps complete, but the walk goes no further.
        if (failures.length > 0) return;
        for (const child of step.next ?? []) release(child);
      })
      .catch((error: unknown) => {
        const failure = new StepFailure(step, error);
        failures.push(failure);
        emit({ type: "output", line: `${step.name}: failed: ${failure.message}` });
        options.logger
          ?.child({ step: step.name, error: (error as Error)?.message })
          .warn("step failed");
      })
      .finally(() => running.delete(run));
    running.add(run);
  };

  for (const root of plan.steps) release(root);

  // A started step's promise removes itself when it settles, so racing the set
  // until it drains is the whole scheduler; starts triggered by a settling step
  // land in the set before the next race.
  while (running.size > 0) await Promise.race(running);

  if (failures.length > 0) {
    const listed = failures.map((failure) => `  - ${failure.message}`).join("\n");
    throw new ProjectStateError(
      `Plan '${plan.name}' completed with ${failures.length === 1 ? "an error" : "errors"}:\n${listed}`,
      { cause: failures[0]!.reason },
    );
  }
  options.logger?.child({ plan: plan.name }).debug("plan completed");
}
