import type { StatusAgentError, StatusRunningAgent } from '../api-types';
import type { RouteContext } from './route-context';
import type { ServerResponse } from 'node:http';

/** GET /api/status — returns available agents, which ones are running, and any errors */
export function handleStatus(ctx: RouteContext, res: ServerResponse, origin?: string): void {
  const { agents } = ctx.options;
  const running: StatusRunningAgent[] = [];

  for (const [name, { port }] of ctx.runningAgents) {
    running.push({ name, port });
  }

  // Collect per-agent errors
  const errors: StatusAgentError[] = [];
  for (const [name, agentError] of ctx.agentErrors) {
    errors.push({ name, message: agentError.message });
  }

  ctx.setCorsHeaders(res, origin);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({ mode: ctx.options.mode, agents, running, errors, selectedAgent: ctx.options.selectedAgent })
  );
}
