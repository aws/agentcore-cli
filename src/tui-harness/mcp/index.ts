import { startHttpServer } from './http-server.js';
import { closeAllSessions, createServer } from './server.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const DEFAULT_PORT = 24100;
const MIN_PORT = 1024;
const MAX_PORT = 65535;

interface TransportConfig {
  mode: 'stdio' | 'http';
  port: number;
}

/**
 * Parses CLI arguments and environment variables to determine transport mode and port.
 *
 * Priority: CLI flags take precedence over environment variables.
 *
 * Flags:
 *   --http              Use HTTP transport instead of stdio
 *   --port <number>     Port for HTTP transport (default: 24100)
 *
 * Environment variables:
 *   MCP_HARNESS_TRANSPORT   Set to 'http' for HTTP mode
 *   MCP_HARNESS_PORT        Port for HTTP transport
 */
function parseArgs(): TransportConfig {
  const args = process.argv.slice(2);

  // Determine mode from CLI flag, then env var, defaulting to stdio
  const httpFlagPresent = args.includes('--http');
  const envTransport = process.env.MCP_HARNESS_TRANSPORT;
  const mode: 'stdio' | 'http' = httpFlagPresent || envTransport === 'http' ? 'http' : 'stdio';

  // Determine port from CLI flag, then env var, defaulting to DEFAULT_PORT
  let port = DEFAULT_PORT;

  const portFlagIndex = args.indexOf('--port');
  if (portFlagIndex !== -1) {
    const portArg = args[portFlagIndex + 1];
    if (portArg === undefined) {
      console.error('Error: --port flag requires a value.');
      process.exit(1);
    }
    port = parsePort(portArg);
  } else if (process.env.MCP_HARNESS_PORT !== undefined) {
    port = parsePort(process.env.MCP_HARNESS_PORT);
  }

  return { mode, port };
}

/**
 * Parses and validates a port string. Exits with an error if the value is not
 * a valid integer in the range 1024-65535.
 */
function parsePort(value: string): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < MIN_PORT || parsed > MAX_PORT) {
    console.error(`Error: Invalid port "${value}". Must be an integer between ${MIN_PORT} and ${MAX_PORT}.`);
    process.exit(1);
  }

  return parsed;
}

async function main(): Promise<void> {
  const { mode, port } = parseArgs();

  if (mode === 'http') {
    await startHttpServer(port);
    return;
  }

  // Stdio mode (default)
  const server = createServer();
  const transport = new StdioServerTransport();

  // Graceful shutdown handler
  const shutdown = async (): Promise<void> => {
    await closeAllSessions();
    await server.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => {
    void shutdown();
  });
  process.on('SIGINT', () => {
    void shutdown();
  });

  // Connect server to stdio transport
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error('MCP harness failed to start:', error);
  process.exit(1);
});
