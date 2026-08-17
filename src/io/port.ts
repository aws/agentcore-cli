import { createServer } from "node:net";

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
