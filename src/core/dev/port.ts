import { createServer } from "node:net";

/** How many ports above the requested one to try before giving up. */
const MAX_PORT_ATTEMPTS = 100;

/** True if `port` is free on loopback. Only EADDRINUSE counts as taken;
 *  other errors (e.g. EACCES) reject so the caller isn't misled into
 *  walking past a real failure. */
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolve(false);
      else reject(error);
    });
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

/**
 * Finds the first free port at or above `start`, walking upward.
 * Throws after {@link MAX_PORT_ATTEMPTS} so a saturated range fails loudly.
 */
export async function findAvailablePort(start: number): Promise<number> {
  for (let port = start; port < start + MAX_PORT_ATTEMPTS; port++) {
    if (await portFree(port)) return port;
  }
  throw new Error(`no free port found in range ${start}-${start + MAX_PORT_ATTEMPTS - 1}`);
}
