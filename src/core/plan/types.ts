/**
 * What a step's read call observed: the work has not been issued, is in
 * progress, is done, or is broken in a way that re-issuing will not fix.
 */
export type StepStatus = "NOT_STARTED" | "WAITING" | "SUCCESSFUL" | "FAILED";

/**
 * One unit of a deployment. A step never decides for itself whether to act: the
 * engine asks `status` first and only calls `do` when the world says the work
 * is absent. That is what makes a plan idempotent (a satisfied step issues no
 * call), self-healing (a deleted resource reads as NOT_STARTED and is recreated)
 * and resumable (a killed run picks up from whatever the read calls report).
 */
/** Emits one progress line under the running step; the engine prefixes the step name. */
export type StepReporter = (line: string) => void;

export interface Step {
  /** Unique within a plan; used in progress output and errors. */
  name: string;
  /**
   * Issues the mutating call. Called only when `status` reports NOT_STARTED.
   * `report` lets a step that does several things (upload many objects) show
   * its progress; a step with one call ignores it.
   */
  do(report: StepReporter): Promise<void>;
  /**
   * Observes the world. Must be side-effect free and safe to call repeatedly. A
   * step that needs to explain a FAILED reading throws instead of returning it;
   * the error becomes the step's failure.
   */
  status(): Promise<StepStatus>;
  /** Steps that may start once this one is SUCCESSFUL. A step may appear under several parents. */
  next?: Step[];
}

/**
 * A polytree of steps: a DAG whose nodes may have several parents. Roots start
 * concurrently; a step with several parents runs once its last parent succeeds.
 */
export interface Plan {
  name: string;
  /** Root steps; they start concurrently. */
  steps: Step[];
}
