import type { DevServer } from '../../server';
import type { AgentError } from '../constants';
import type { WebUIOptions } from '../web-server';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Shared context passed to every route handler.
 * Provides access to server options, running agent state, and HTTP helpers.
 */
export interface RouteContext {
  readonly options: WebUIOptions;
  /** Map of agentName → running agent server + port */
  readonly runningAgents: Map<string, { server: DevServer; port: number; protocol: string }>;
  /** Map of agentName → in-flight start promise (prevents duplicate starts) */
  readonly startingAgents: Map<string, Promise<{ success: boolean; name: string; port: number; error?: string }>>;
  /** Map of agentName → error state (set when an agent fails to start or crashes) */
  readonly agentErrors: Map<string, AgentError>;
  /** Set CORS headers on the response */
  setCorsHeaders(res: ServerResponse, origin?: string): void;
  /** Read the full request body as a string */
  readBody(req: IncomingMessage): Promise<string>;
}

/**
 * Parse the URL from an incoming request and return the pathname and a
 * helper to read query-string parameters.
 *
 * Usage:
 *   const { pathname, param } = parseRequestUrl(req);
 *   const agentName = param('agentName');   // string or undefined
 */
export function parseRequestUrl(req: IncomingMessage): {
  pathname: string;
  param: (name: string) => string | undefined;
} {
  const url = new URL(req.url ?? '', `http://${req.headers.host}`);
  return {
    pathname: url.pathname,
    param: (name: string) => url.searchParams.get(name) ?? undefined,
  };
}
