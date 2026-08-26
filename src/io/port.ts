import { connect, createServer } from "node:net";

export type PortChecker = (port: number, signal: AbortSignal) => Promise<boolean>;

function canBind(port: number, host: string, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();

  return new Promise<boolean>((resolve, reject) => {
    const server = createServer().unref();
    server.once("error", () => resolve(false));
    server.once("close", () => {
      if (signal.aborted) reject(signal.reason);
    });
    server.listen({ port, host, exclusive: true, signal }, () => {
      server.close(() => resolve(true));
    });
  });
}

/** Checks that a port can be bound by both loopback-only and all-interface servers. */
export const checkPort: PortChecker = async (port, signal) => {
  if (!(await canBind(port, "127.0.0.1", signal))) return false;
  signal.throwIfAborted();
  const available = await canBind(port, "0.0.0.0", signal);
  signal.throwIfAborted();
  return available;
};

/** How long an agent may stay silent before its startup is abandoned. */
const IDLE_TIMEOUT_MS = 120_000;

/**
 * Poll until a loopback TCP connection to `port` succeeds, the signal aborts,
 * or the agent has been silent past `idleMs`. Timing off the last output rather
 * than a fixed deadline lets a still-building container keep its start alive.
 */
export function waitForPort(
  port: number,
  signal: AbortSignal,
  lastActivityAt?: () => number,
  intervalMs = 250,
  idleMs = IDLE_TIMEOUT_MS,
): Promise<void> {
  const startedAt = Date.now();
  const since = lastActivityAt ?? (() => startedAt);
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (signal.aborted) {
        reject(new Error("Aborted while waiting for the agent to become ready."));
        return;
      }
      if (Date.now() - since() > idleMs) {
        reject(
          new Error(
            `Agent produced no output and did not accept connections on port ${port} within ${idleMs / 1000}s.`,
          ),
        );
        return;
      }
      const socket = connect({ port, host: "127.0.0.1" }, () => {
        socket.destroy();
        resolve();
      });
      const onAbort = () => {
        socket.destroy();
        reject(new Error("Aborted while waiting for the agent to become ready."));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      socket.once("close", () => signal.removeEventListener("abort", onAbort));
      if (signal.aborted) onAbort();
      socket.on("error", () => {
        socket.destroy();
        setTimeout(attempt, intervalMs);
      });
    };
    attempt();
  });
}
