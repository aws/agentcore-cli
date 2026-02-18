import { createServer } from 'net';

/** Check if a port is available on a specific host */
function checkPort(port: number, host: string): Promise<boolean> {
  return new Promise(resolve => {
    const server = createServer();
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
    server.on('error', () => resolve(false));
  });
}

/** Check if a port is available on both localhost and all interfaces. */
async function isPortAvailable(port: number): Promise<boolean> {
  // Check both: container runtimes bind on 0.0.0.0, local servers on 127.0.0.1
  const [loopback, allInterfaces] = await Promise.all([checkPort(port, '127.0.0.1'), checkPort(port, '0.0.0.0')]);
  return loopback && allInterfaces;
}

export async function findAvailablePort(startPort: number): Promise<number> {
  let port = startPort;
  while (!(await isPortAvailable(port))) {
    port++;
  }
  return port;
}

/** Wait for a specific port to become available, with timeout */
export async function waitForPort(port: number, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isPortAvailable(port)) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

export function convertEntrypointToModule(entrypoint: string): string {
  if (entrypoint.includes(':')) return entrypoint;
  const path = entrypoint.replace(/\.py$/, '').replace(/\//g, '.');
  return `${path}:app`;
}
