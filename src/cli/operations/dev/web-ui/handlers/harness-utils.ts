import type { HarnessSystemPrompt, InvokeHarnessOptions } from '../../../../aws/agentcore-harness';
import type { HarnessInvocationOverrides } from '../api-types';

const DEFAULT_MAX_ITERATIONS = 75;

export function buildInvokeOptions(
  harnessArn: string,
  region: string,
  sessionId: string,
  messages: InvokeHarnessOptions['messages'],
  overrides?: HarnessInvocationOverrides
): InvokeHarnessOptions {
  const opts: InvokeHarnessOptions = {
    region,
    harnessArn,
    runtimeSessionId: sessionId,
    messages,
  };

  if (overrides?.model) opts.model = overrides.model;
  if (overrides?.systemPrompt) opts.systemPrompt = [{ text: overrides.systemPrompt }] as HarnessSystemPrompt;
  if (overrides?.skills) opts.skills = overrides.skills;
  if (overrides?.actorId) opts.actorId = overrides.actorId;
  opts.maxIterations = overrides?.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  if (overrides?.maxTokens != null) opts.maxTokens = overrides.maxTokens;
  if (overrides?.timeoutSeconds != null) opts.timeoutSeconds = overrides.timeoutSeconds;
  if (overrides?.allowedTools) opts.allowedTools = overrides.allowedTools;
  if (overrides?.tools) opts.tools = overrides.tools;

  return opts;
}
