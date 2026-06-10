import { AgentEnvironment, AgentProtocol, AuthType, standardize } from '../../telemetry/schemas/common-shapes.js';

function isHarnessInvoke(options: {
  harnessName?: string;
  harnessArn?: string;
  harnessCount: number;
  runtimeCount: number;
}): boolean {
  if (options.harnessName || options.harnessArn) return true;
  if (options.harnessCount > 0 && options.runtimeCount === 0) return true;
  return false;
}

export function computeInvokeAttrs(options: {
  preview: boolean;
  harnessName?: string;
  harnessArn?: string;
  harnessCount: number;
  runtimeCount: number;
  stream: boolean;
  hasSessionId: boolean;
  bearerToken?: string;
  agentProtocol?: string;
}) {
  const isHarness = options.preview && isHarnessInvoke(options);
  return {
    agent_environment: standardize(AgentEnvironment, isHarness ? 'harness' : 'runtime'),
    has_stream: options.stream,
    has_session_id: options.hasSessionId,
    auth_type: standardize(AuthType, options.bearerToken ? 'bearer_token' : 'sigv4'),
    agent_protocol: isHarness ? undefined : standardize(AgentProtocol, options.agentProtocol ?? 'http'),
  };
}
