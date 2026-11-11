import type { CloudFormationClient } from "@aws-sdk/client-cloudformation";

/** A CloudFormation command as the fake sees it: its class name and input. */
export type SentCommand = { name: string; input: Record<string, unknown> };

type Responder = (input: Record<string, unknown>) => unknown;

/**
 * A scripted CloudFormation client for migrate's refactor tests. Each command
 * name maps to a queue of responses (a value, a function of the input, or an
 * Error to throw); the last one repeats once the queue runs out.
 */
export function fakeCloudFormation(script: Record<string, Array<unknown | Responder>>): {
  client: CloudFormationClient;
  sent: SentCommand[];
} {
  const sent: SentCommand[] = [];
  const queues = new Map(Object.entries(script).map(([name, list]) => [name, [...list]]));
  const client = {
    send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = command.constructor.name.replace(/Command$/, "");
      sent.push({ name, input: command.input });
      const queue = queues.get(name);
      if (!queue || queue.length === 0) throw new Error(`unexpected ${name}`);
      const next = queue.length > 1 ? queue.shift() : queue[0];
      const value = typeof next === "function" ? (next as Responder)(command.input) : next;
      if (value instanceof Error) throw value;
      return value;
    },
  };
  return { client: client as unknown as CloudFormationClient, sent };
}

/** ListStackRefactorActions output moving each `[from, to]` within `stackName`. */
export function moveActions(stackName: string, moves: Array<[string, string]>) {
  return {
    StackRefactorActions: moves.map(([from, to]) => ({
      Action: "MOVE",
      Entity: "RESOURCE",
      PhysicalResourceId: `phys-${from}`,
      ResourceMapping: {
        Source: { StackName: stackName, LogicalResourceId: from },
        Destination: { StackName: stackName, LogicalResourceId: to },
      },
    })),
  };
}

/** ListStackResources output for logical ID → physical ID pairs. */
export function stackResources(pairs: Array<[string, string]>) {
  return {
    StackResourceSummaries: pairs.map(([logical, physical]) => ({
      LogicalResourceId: logical,
      PhysicalResourceId: physical,
    })),
  };
}

/** Poll options that never wait. */
export const NO_WAIT = { intervalMs: 0, sleep: async () => {} };
