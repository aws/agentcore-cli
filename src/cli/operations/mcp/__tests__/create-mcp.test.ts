import { computeDefaultGatewayEnvVarName, computeDefaultMcpRuntimeEnvVarName } from '../create-mcp.js';
import { describe, expect, it } from 'vitest';

describe('computeDefaultGatewayEnvVarName', () => {
  it('converts simple name to env var', () => {
    expect(computeDefaultGatewayEnvVarName('mygateway')).toBe('AGENTCORE_GATEWAY_MYGATEWAY_URL');
  });

  it('replaces hyphens with underscores', () => {
    expect(computeDefaultGatewayEnvVarName('my-gateway')).toBe('AGENTCORE_GATEWAY_MY_GATEWAY_URL');
  });

  it('uppercases the name', () => {
    expect(computeDefaultGatewayEnvVarName('MyGateway')).toBe('AGENTCORE_GATEWAY_MYGATEWAY_URL');
  });

  it('handles multiple hyphens', () => {
    expect(computeDefaultGatewayEnvVarName('my-cool-gateway')).toBe('AGENTCORE_GATEWAY_MY_COOL_GATEWAY_URL');
  });

  it('handles already uppercase name', () => {
    expect(computeDefaultGatewayEnvVarName('GW')).toBe('AGENTCORE_GATEWAY_GW_URL');
  });
});

describe('computeDefaultMcpRuntimeEnvVarName', () => {
  it('converts simple name to env var', () => {
    expect(computeDefaultMcpRuntimeEnvVarName('myruntime')).toBe('AGENTCORE_MCPRUNTIME_MYRUNTIME_URL');
  });

  it('replaces hyphens with underscores', () => {
    expect(computeDefaultMcpRuntimeEnvVarName('my-runtime')).toBe('AGENTCORE_MCPRUNTIME_MY_RUNTIME_URL');
  });

  it('uppercases the name', () => {
    expect(computeDefaultMcpRuntimeEnvVarName('MyRuntime')).toBe('AGENTCORE_MCPRUNTIME_MYRUNTIME_URL');
  });

  it('handles multiple hyphens', () => {
    expect(computeDefaultMcpRuntimeEnvVarName('a-b-c')).toBe('AGENTCORE_MCPRUNTIME_A_B_C_URL');
  });
});
