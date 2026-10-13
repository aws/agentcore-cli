import {
  CreateStackRefactorCommand,
  DescribeStackEventsCommand,
  DescribeStackRefactorCommand,
  ExecuteStackRefactorCommand,
  ListStackRefactorActionsCommand,
  type CloudFormationClient,
  type DescribeStackRefactorCommandOutput,
  type StackRefactorAction,
} from "@aws-sdk/client-cloudformation";
import type { CfnTemplate } from "./templates";
import { templateLocation, type TemplateStore } from "./templateStore";

/** One deployed stack to refactor onto new logical IDs. */
export type RefactorStack = {
  target: string;
  region: string;
  stackName: string;
  /** Logical ID renames, deployed ID → new ID. */
  renames: ReadonlyMap<string, string>;
  /** The deployed template with the renames applied. */
  template: CfnTemplate;
  /** A CloudFormation client for the stack's account and region. */
  client: CloudFormationClient;
  /** Where a template too big to pass inline is uploaded. */
  templates: () => Promise<TemplateStore>;
};

export type PollOptions = {
  /** Between status reads; defaults to 5 s. */
  intervalMs?: number;
  /** Gives up after this long; defaults to 30 minutes (memory moves take over a minute each). */
  timeoutMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  onStep?: (message: string) => void;
  /** Gets a line per stack resource event while a refactor executes. */
  onOutput?: (line: string) => void;
};

/**
 * Why a refactor stopped: it was never created; it failed and left the stack
 * unchanged; it couldn't roll back, leaving the stack part-moved; or its outcome
 * couldn't be read. The last two need a person to look at the stack.
 */
export type RefactorFailureKind =
  "create-failed" | "execute-failed" | "rollback-failed" | "unknown";

/** Whether a failure leaves the stack in a state only a person can sort out. */
export function needsManualRepair(error: unknown): error is StackRefactorError {
  return (
    error instanceof StackRefactorError &&
    (error.details.kind === "rollback-failed" || error.details.kind === "unknown")
  );
}

/** A stack refactor that didn't finish. */
export class StackRefactorError extends Error {
  constructor(
    message: string,
    readonly details: {
      kind: RefactorFailureKind;
      stackName: string;
      region: string;
      refactorId?: string;
      status?: string;
      reason?: string;
    },
  ) {
    super(message);
    this.name = "StackRefactorError";
  }
}

/** One action a created stack refactor will take, as CloudFormation lists it. */
export type RefactorAction = {
  /** `MOVE` for every resource a migration refactor moves. */
  action: string;
  entity: string;
  /** Logical ID the resource moves from. */
  from: string;
  /** Logical ID the resource moves to. */
  to: string;
  physicalResourceId?: string;
  /** CloudFormation's note, e.g. "No configuration changes detected." */
  description?: string;
};

/** A created stack refactor, not yet executed, with what it would do. */
export type CreatedRefactor = {
  stack: RefactorStack;
  refactorId: string;
  actions: RefactorAction[];
};

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Creates the stack refactor that moves `stack`'s resources to their new logical
 * IDs, waits for CloudFormation to validate it, and lists the actions it would
 * take. Nothing in the stack changes until it's executed.
 */
export async function createRefactor(
  stack: RefactorStack,
  options: PollOptions & { description?: string } = {},
): Promise<CreatedRefactor> {
  const { stackName, region, client } = stack;
  const template = await templateLocation(stack.template, stackName, stack.templates);
  let refactorId: string | undefined;
  try {
    const response = await client.send(
      new CreateStackRefactorCommand({
        Description:
          options.description ?? `agentcore migrate: move ${stackName} to v1 logical IDs`,
        EnableStackCreation: false,
        StackDefinitions: [{ StackName: stackName, ...template.location }],
        ResourceMappings: [...stack.renames].map(([from, to]) => ({
          Source: { StackName: stackName, LogicalResourceId: from },
          Destination: { StackName: stackName, LogicalResourceId: to },
        })),
      }),
    );
    refactorId = response.StackRefactorId;
    if (!refactorId) throw new Error("CloudFormation returned no stack refactor ID.");
    const id = refactorId;
    const created = await poll(
      () => describe(client, id),
      (state) => !state.Status?.endsWith("_IN_PROGRESS"),
      options,
    );
    if (created.Status !== "CREATE_COMPLETE") {
      throw new StackRefactorError(
        `CloudFormation rejected the refactor of stack '${stackName}' (${created.Status ?? "UNKNOWN"}): ` +
          `${created.StatusReason ?? "no reason given"}. Nothing was changed.`,
        {
          kind: "create-failed",
          stackName,
          region,
          refactorId: id,
          ...(created.Status && { status: created.Status }),
          ...(created.StatusReason && { reason: created.StatusReason }),
        },
      );
    }
    return { stack, refactorId: id, actions: await listActions(client, id) };
  } catch (error) {
    if (error instanceof StackRefactorError) throw error;
    throw new StackRefactorError(
      `Couldn't create the refactor of stack '${stackName}': ${(error as Error).message}. Nothing was changed.`,
      { kind: "create-failed", stackName, region, ...(refactorId && { refactorId }) },
    );
  } finally {
    await template.release();
  }
}

/**
 * Executes a created refactor and waits for it to finish. A refactor that fails
 * and rolls back leaves the stack as it was; one that can't roll back leaves it
 * part-moved, which only manual work can repair; one whose outcome couldn't be
 * read is `unknown`, and must be checked before anything else is done to it.
 */
export async function executeRefactor(
  created: CreatedRefactor,
  options: PollOptions = {},
): Promise<void> {
  const { stack, refactorId } = created;
  const { client, stackName, region } = stack;
  const details = (state?: DescribeStackRefactorCommandOutput, fallbackReason?: string) => {
    const status = state?.ExecutionStatus;
    const reason = state?.ExecutionStatusReason ?? state?.StatusReason ?? fallbackReason;
    return { stackName, region, refactorId, ...(status && { status }), ...(reason && { reason }) };
  };
  const lost = (error: Error): never => {
    throw new StackRefactorError(
      `Lost track of the refactor of stack '${stackName}' (${error.message}), so whether it ` +
        "finished isn't known.",
      { kind: "unknown", ...details(undefined, error.message) },
    );
  };

  // Each move is an export and an import: two completed events per resource.
  const events = options.onOutput
    ? await stackEvents(client, stackName, stack.renames.size * 2, options.onOutput)
    : undefined;
  try {
    await client.send(new ExecuteStackRefactorCommand({ StackRefactorId: refactorId }));
  } catch (error) {
    // Only CloudFormation answering with a client error proves it didn't take the
    // request. A timeout, a server error, or a lost response may have reached it
    // anyway, and an accepted execution can read AVAILABLE for a while before it
    // starts, so its outcome is unknown until a person (or a rerun) checks.
    const message = (error as Error).message;
    if (isClientError(error)) {
      throw new StackRefactorError(
        `CloudFormation refused to start the refactor of stack '${stackName}': ${message}. ` +
          "The stack is unchanged.",
        { kind: "execute-failed", ...details(undefined, message) },
      );
    }
    throw new StackRefactorError(
      `The request to start the refactor of stack '${stackName}' failed (${message}), so ` +
        "whether CloudFormation started it isn't known.",
      { kind: "unknown", ...details(undefined, message) },
    );
  }
  options.onStep?.(`Refactoring stack ${stackName}`);
  let state: DescribeStackRefactorCommandOutput;
  try {
    const read = async () => {
      await events?.();
      return describe(client, refactorId);
    };
    state = await poll(
      read,
      // Until the execution is picked up the refactor can still read AVAILABLE.
      (current) =>
        current.ExecutionStatus !== "AVAILABLE" &&
        !current.ExecutionStatus?.endsWith("_IN_PROGRESS"),
      options,
    );
    if (state.ExecutionStatus === "EXECUTE_FAILED") {
      // A failed execution may still be about to roll back: give it a few more
      // reads to show ROLLBACK_IN_PROGRESS, and follow the rollback if it does.
      let reads = 0;
      state = await poll(
        read,
        (current) =>
          (current.ExecutionStatus === "EXECUTE_FAILED" && ++reads > EXECUTE_FAILED_GRACE_READS) ||
          (current.ExecutionStatus !== "EXECUTE_FAILED" &&
            !current.ExecutionStatus?.endsWith("_IN_PROGRESS")),
        options,
      );
    }
  } catch (error) {
    lost(error as Error);
  }
  await events?.();
  const status = state!.ExecutionStatus;
  if (status === "EXECUTE_COMPLETE") return;
  const reason = details(state!).reason ?? "no reason given";
  if (status === "ROLLBACK_FAILED") {
    throw new StackRefactorError(
      `The refactor of stack '${stackName}' failed and CloudFormation couldn't roll it back ` +
        `(${reason}). Some resources may be under their old logical IDs and some under their new ones.`,
      { kind: "rollback-failed", ...details(state!) },
    );
  }
  if (status === "EXECUTE_FAILED" || status === "ROLLBACK_COMPLETE") {
    throw new StackRefactorError(
      `The refactor of stack '${stackName}' failed (${status}): ${reason}. CloudFormation ` +
        "rolled it back, so the stack is unchanged.",
      { kind: "execute-failed", ...details(state!) },
    );
  }
  // OBSOLETE, UNAVAILABLE, or a status this code doesn't know.
  throw new StackRefactorError(
    `The refactor of stack '${stackName}' ended ${status ?? "with no status"} (${reason}), so ` +
      "whether it moved anything isn't known.",
    { kind: "unknown", ...details(state!) },
  );
}

/**
 * Reports the stack's resource events as they happen, one deploy-style line each
 * (`<stack> | <n>/<total> | <status> | <type> | <logical ID>`, where n counts the
 * completed ones), skipping events from before the refactor and the stack's own.
 * Returns a function to call on each poll. Events are only shown: reading them
 * never fails the refactor.
 */
async function stackEvents(
  client: CloudFormationClient,
  stackName: string,
  total: number,
  onOutput: (line: string) => void,
): Promise<() => Promise<void>> {
  const seen = new Set<string>();
  let completed = 0;
  const read = async (report: boolean) => {
    try {
      const output = await client.send(new DescribeStackEventsCommand({ StackName: stackName }));
      // Newest first; report oldest first.
      for (const event of [...(output.StackEvents ?? [])].reverse()) {
        if (!event.EventId || seen.has(event.EventId)) continue;
        seen.add(event.EventId);
        if (!report || event.ResourceType === "AWS::CloudFormation::Stack") continue;
        if (event.ResourceStatus?.endsWith("_COMPLETE")) completed++;
        onOutput(
          `${stackName} | ${completed}/${total} | ${event.ResourceStatus} | ` +
            `${event.ResourceType} | ${event.LogicalResourceId}`,
        );
      }
    } catch {
      // Showing progress is best effort.
    }
  };
  // What's there before the refactor starts is history, not progress.
  await read(false);
  return () => read(true);
}

/** Reads after EXECUTE_FAILED in which a rollback may still start. */
const EXECUTE_FAILED_GRACE_READS = 3;

/** Whether an AWS SDK error is CloudFormation's own answer that it refused the request (HTTP 4xx). */
export function isClientError(error: unknown): boolean {
  const status = (error as { $metadata?: { httpStatusCode?: number } } | undefined)?.$metadata
    ?.httpStatusCode;
  return typeof status === "number" && status >= 400 && status < 500;
}

export async function describe(
  client: CloudFormationClient,
  refactorId: string,
): Promise<DescribeStackRefactorCommandOutput> {
  return client.send(new DescribeStackRefactorCommand({ StackRefactorId: refactorId }));
}

async function listActions(
  client: CloudFormationClient,
  refactorId: string,
): Promise<RefactorAction[]> {
  const actions: StackRefactorAction[] = [];
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListStackRefactorActionsCommand({
        StackRefactorId: refactorId,
        ...(token && { NextToken: token }),
      }),
    );
    actions.push(...(page.StackRefactorActions ?? []));
    token = page.NextToken;
  } while (token);
  return actions.map((action) => ({
    action: action.Action ?? "UNKNOWN",
    entity: action.Entity ?? "UNKNOWN",
    from: action.ResourceMapping?.Source?.LogicalResourceId ?? "",
    to: action.ResourceMapping?.Destination?.LogicalResourceId ?? "",
    ...(action.PhysicalResourceId && { physicalResourceId: action.PhysicalResourceId }),
    ...(action.Description && { description: action.Description }),
  }));
}

/** Consecutive failed reads a poll rides out before failing. */
const MAX_FAILED_READS = 3;

/** Reads until `done` holds, sleeping between reads, failing after the timeout. */
export async function poll<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  options: PollOptions = {},
): Promise<T> {
  const interval = options.intervalMs ?? 5_000;
  const timeout = options.timeoutMs ?? 30 * 60_000;
  const sleep = options.sleep ?? sleepFor;
  const deadline = Date.now() + timeout;
  let failedReads = 0;
  for (;;) {
    let value: T;
    try {
      value = await read();
      failedReads = 0;
    } catch (error) {
      // The SDK has already retried; a few more reads ride out a longer blip.
      if (++failedReads > MAX_FAILED_READS || Date.now() >= deadline) throw error;
      await sleep(interval);
      continue;
    }
    if (done(value)) return value;
    if (Date.now() >= deadline) {
      throw new Error(`still not finished after ${Math.round(timeout / 1000)} s`);
    }
    await sleep(interval);
  }
}
