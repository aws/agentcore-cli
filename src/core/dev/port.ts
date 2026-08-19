import { InputValidationError } from "../../errors";
import type { ProjectRuntime } from "../../projectSchemas/runtime";
import type { PortChecker } from "../../io";

const MAX_PORT_ATTEMPTS = 100;
export const DEV_PORTS = { HTTP: 8080, AGUI: 8080, MCP: 8000, A2A: 9000 } as const;

export type DevPort = {
  port: number;
  requestedPort: number;
};

export class PortInUseError extends InputValidationError {
  constructor(port: number) {
    super(
      `Port ${port} is already in use. Find the process with ` +
        `'lsof -i :${port}' (macOS/Linux) or 'netstat -ano | findstr :${port}' (Windows), ` +
        "then stop it or choose a different --port.",
    );
  }
}

export async function resolveDevPort(
  protocol: ProjectRuntime["protocol"],
  explicitPort: number | undefined,
  checkPort: PortChecker,
  signal: AbortSignal,
): Promise<DevPort> {
  const defaultPort = DEV_PORTS[protocol ?? "HTTP"];
  const requestedPort = explicitPort ?? defaultPort;

  if (await checkPort(requestedPort, signal)) {
    return { port: requestedPort, requestedPort };
  }

  if (explicitPort !== undefined) {
    throw new PortInUseError(requestedPort);
  }

  for (let port = requestedPort + 1; port < requestedPort + MAX_PORT_ATTEMPTS; port++) {
    if (await checkPort(port, signal)) return { port, requestedPort };
  }

  throw new InputValidationError(
    `No free port found in range ${requestedPort}-${requestedPort + MAX_PORT_ATTEMPTS - 1}.`,
  );
}
