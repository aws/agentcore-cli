export interface InvokeOptions {
  agentName?: string;
  targetName?: string;
  prompt?: string;
  sessionId?: string;
  json?: boolean;
  stream?: boolean;
}

export interface InvokeResult {
  success: boolean;
  agentName?: string;
  targetName?: string;
  response?: string;
  error?: string;
  logFilePath?: string;
}
