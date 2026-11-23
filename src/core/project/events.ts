import type { ProjectEvent } from "../../handlers/project/types";
import { AsyncChannel } from "../../io";

/**
 * Runs `operation`, yielding every event handed to its `emit` callback while the
 * operation is in flight, then returns (or rethrows) its result. This is the seam
 * between push-style sources (process chunk callbacks, the CDK Toolkit's ioHost,
 * a download's start) and the pull-based ProjectEvent generators long-running
 * commands expose: the operation pushes, the enclosing generator's consumer pulls.
 */
export async function* withEvents<T>(
  operation: (emit: (event: ProjectEvent) => void) => Promise<T>,
): AsyncGenerator<ProjectEvent, T> {
  const channel = new AsyncChannel<ProjectEvent>();
  const running = operation((event) => channel.push(event));
  // The rejection is consumed by the await below; this handler only keeps the
  // window between the failure and the channel draining from being reported as
  // an unhandled rejection.
  running.catch(() => {}).finally(() => channel.close());
  for await (const event of channel) yield event;
  return await running;
}

/** {@link withEvents} for an operation that emits lines, each yielded as an `output` event. */
export function withOutputEvents<T>(
  operation: (emit: (line: string) => void) => Promise<T>,
): AsyncGenerator<ProjectEvent, T> {
  return withEvents((emit) => operation((line) => emit({ type: "output", line })));
}
