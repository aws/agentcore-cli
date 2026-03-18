import { createConnection, createServer } from 'net';

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
  // Check sequentially: concurrent binds on overlapping addresses (0.0.0.0 includes 127.0.0.1)
  // can cause false negatives because the first server hasn't released the port before the second tries.
  const loopback = await checkPort(port, '127.0.0.1');
  if (!loopback) return false;
  const allInterfaces = await checkPort(port, '0.0.0.0');
  return allInterfaces;
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

/** Wait until a server is accepting connections on the given port, with timeout. */
export async function waitForServerReady(port: number, timeoutMs = 60000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const listening = await new Promise<boolean>(resolve => {
      const socket = createConnection({ port, host: '127.0.0.1' }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (listening) return true;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return false;
}

/** Sleep helper for retry delays. */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Protocol-specific endpoint URL for display. */
export function getEndpointUrl(port: number, protocol: string): string {
  switch (protocol) {
    case 'MCP':
      return `http://localhost:${port}/mcp`;
    case 'A2A':
      return `http://localhost:${port}/`;
    default:
      return `http://localhost:${port}/invocations`;
  }
}

/**
 * Format MCP tools into a displayable list string.
 */
export function formatMcpToolList(
  tools: { name: string; description?: string; inputSchema?: Record<string, unknown> }[]
): string {
  const toolLines = tools.map(t => {
    const params = t.inputSchema?.properties
      ? Object.entries(t.inputSchema.properties as Record<string, { type?: string }>)
          .map(([name, schema]) => `${name}: ${schema.type ?? 'any'}`)
          .join(', ')
      : '';
    return `  ${t.name}(${params})${t.description ? ` - ${t.description}` : ''}`;
  });
  return `Available tools (${tools.length}):\n${toolLines.join('\n')}\n\nType: tool_name {"arg": "value"} to call a tool. Type "list" to refresh.`;
}

/**
 * Check if an error is a connection error (ECONNREFUSED or fetch failure).
 * Only matches actual network-level failures, not application errors.
 */
export function isConnectionError(error: Error): boolean {
  return error.message.includes('ECONNREFUSED') || error.message === 'fetch failed';
}

export function convertEntrypointToModule(entrypoint: string): string {
  if (entrypoint.includes(':')) return entrypoint;
  const path = entrypoint.replace(/\.py$/, '').replace(/\//g, '.');
  return `${path}:app`;
}
