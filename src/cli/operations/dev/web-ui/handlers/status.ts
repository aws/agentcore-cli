import type { StatusAgentError, StatusHarness, StatusRunningAgent } from '../api-types';
import type { RouteContext } from './route-context';
import type { ServerResponse } from 'node:http';

/** GET /api/status — returns available agents, harnesses, which agents are running, and any errors */
export function handleStatus(ctx: RouteContext, res: ServerResponse, origin?: string): void {
  const { agents } = ctx.options;
  const running: StatusRunningAgent[] = [];

  for (const [name, { port }] of ctx.runningAgents) {
    running.push({ name, port });
  }

  const errors: StatusAgentError[] = [];
  for (const [name, agentError] of ctx.agentErrors) {
    errors.push({ name, message: agentError.message });
  }

  const harnesses: StatusHarness[] = (ctx.options.harnesses ?? []).map(h => ({ name: h.name }));

  ctx.setCorsHeaders(res, origin);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      mode: ctx.options.mode,
      agents,
      harnesses,
      running,
      errors,
      selectedAgent: ctx.options.selectedAgent,
      selectedHarness: ctx.options.selectedHarness,
    })
  );
}
