import type { StatusAgent, StatusRunningAgent } from './api-types';

export const WEB_UI_LOCAL_URL = 'http://localhost:5173';

/** Default port for the web UI proxy server. Agent ports start above this. */
export const WEB_UI_DEFAULT_PORT = 8081;

/** Metadata about an available agent, passed to WebUIServer at startup */
export type AgentInfo = StatusAgent;

/** Runtime state of a started agent server */
export type RunningAgent = StatusRunningAgent;

/** Per-agent error state tracked by the web UI server */
export interface AgentError {
  message: string;
  timestamp: number;
}
