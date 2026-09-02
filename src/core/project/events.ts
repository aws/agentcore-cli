import type { ProjectEvent } from "../../handlers/project/types";
import { AsyncChannel } from "../../io";

/**
 * Runs `operation`, yielding every line handed to its `emit` callback as an
 * `output` event while the operation is in flight, then returns (or rethrows)
 * its result. This is the seam between push-style output sources (process
 * chunk callbacks, the CDK Toolkit's ioHost) and the pull-based ProjectEvent
 * generators long-running commands expose: the operation pushes, the enclosing
 * generator's consumer pulls.
 */
export async function* withOutputEvents<T>(
  operation: (emit: (line: string) => void) => Promise<T>,
): AsyncGenerator<ProjectEvent, T> {
  const channel = new AsyncChannel<string>();
  const running = operation((line) => channel.push(line));
  // The rejection is consumed by the await below; this handler only keeps the
  // window between the failure and the channel draining from being reported as
  // an unhandled rejection.
  running.catch(() => {}).finally(() => channel.close());
  for await (const line of channel) yield { type: "output", line };
  return await running;
}
