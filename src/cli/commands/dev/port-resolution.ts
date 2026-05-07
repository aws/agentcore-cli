import type { AgentCoreProjectSpec, ProtocolMode } from '../../../schema';
import { resolveAgentPort } from '../../operations/dev';
import type { Command } from '@commander-js/extra-typings';

/**
 * Detect whether --port was passed explicitly on the CLI (or via env/config),
 * as opposed to falling back to the registered default.
 *
 * Commander v14 always provides `command` and `getOptionValueSource` on the
 * action callback. The defensive null check is here so a future Commander
 * upgrade that removes the API doesn't silently turn every --port value into
 * "implicit" (which would re-introduce issue #1079). When the API is missing,
 * we emit a warning via `onWarn` so the regression is visible to operators.
 *
 * Any source other than 'default' counts as explicit so values supplied via
 * env/config/CLI are all honored literally.
 */
export function isPortExplicit(
  command: Pick<Command, 'getOptionValueSource'> | undefined,
  onWarn: (message: string) => void = msg => console.warn(msg)
): boolean {
  if (!command || typeof command.getOptionValueSource !== 'function') {
    onWarn('Warning: Commander command/getOptionValueSource unavailable; --port will be treated as implicit.');
    return false;
  }
  const source = command.getOptionValueSource('port');
  return source !== undefined && source !== 'default';
}

/** Result of resolving the dev server's bind port for the --logs flow. */
export interface DevPortResolution {
  /** The port the dev server should bind to. */
  port: number;
  /** Whether the resolved port differed from the user's `basePort` due to runtime index offset. */
  offset: number;
  /** Informational log lines the caller should emit before binding. */
  infoLogs: string[];
  /** If set, the caller should print this error and exit non-zero (port conflict). */
  conflictError?: string;
}

/**
 * Pure helper that resolves the dev server's bind port for the non-interactive
 * (`--logs`) CLI flow. Mirrors the logic embedded in command.tsx so it can be
 * unit-tested without spawning a CLI process.
 *
 * Precedence:
 *   1. A2A → 9000, MCP → 8000 (framework-fixed; only existing checkAvailable
 *      result determines conflict).
 *   2. HTTP: `resolveAgentPort` (honors `portIsExplicit` literally; otherwise
 *      applies basePort + runtime-index).
 *
 * Conflict semantics:
 *   - A2A/MCP: any deviation from the fixed port → conflictError.
 *   - HTTP + explicit: any deviation from `basePort` → conflictError.
 *   - HTTP + implicit: silently shifts and emits a "Port X in use, using Y" log.
 */
export function resolveDevPort(args: {
  project: AgentCoreProjectSpec | null;
  agentName: string;
  protocol: ProtocolMode;
  basePort: number;
  portIsExplicit: boolean;
  /** Result from `findAvailablePort(targetPort)`; pass through so this stays pure. */
  availablePort: number;
}): DevPortResolution {
  const { project, agentName, protocol, basePort, portIsExplicit, availablePort } = args;
  const isA2A = protocol === 'A2A';
  const isMcp = protocol === 'MCP';
  const httpResolution = resolveAgentPort(project, agentName, basePort, { explicit: portIsExplicit });
  const targetPort = isA2A ? 9000 : isMcp ? 8000 : httpResolution.port;

  const infoLogs: string[] = [];

  // Surface the index-based offset so it isn't silent (issue #1079).
  if (!isA2A && !isMcp && httpResolution.offset > 0) {
    infoLogs.push(
      `Runtime "${agentName}" is at index ${httpResolution.offset}; using port ${targetPort} ` +
        `(pass --port ${targetPort} explicitly to override).`
    );
  }

  // Conflict checks
  if ((isA2A || isMcp) && availablePort !== targetPort) {
    return {
      port: targetPort,
      offset: httpResolution.offset,
      infoLogs,
      conflictError: `Port ${targetPort} is in use. ${protocol} agents require port ${targetPort}.`,
    };
  }
  if (!isA2A && !isMcp && portIsExplicit && availablePort !== targetPort) {
    return {
      port: targetPort,
      offset: httpResolution.offset,
      infoLogs,
      conflictError: `Port ${targetPort} is in use. Pass a different --port or stop the conflicting process.`,
    };
  }
  if (availablePort !== targetPort) {
    infoLogs.push(`Port ${targetPort} in use, using ${availablePort}`);
  }

  return {
    port: availablePort,
    offset: httpResolution.offset,
    infoLogs,
  };
}
