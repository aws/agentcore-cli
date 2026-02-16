import { computeDefaultGatewayEnvVarName, computeDefaultMcpRuntimeEnvVarName } from '../create-mcp.js';
import { describe, expect, it } from 'vitest';

describe('computeDefaultGatewayEnvVarName', () => {
  it('uppercases and wraps gateway name', () => {
    expect(computeDefaultGatewayEnvVarName('my-gateway')).toBe('AGENTCORE_GATEWAY_MY_GATEWAY_URL');
  });

  it('replaces hyphens with underscores', () => {
    expect(computeDefaultGatewayEnvVarName('multi-part-name')).toBe('AGENTCORE_GATEWAY_MULTI_PART_NAME_URL');
  });

  it('handles name with no hyphens', () => {
    expect(computeDefaultGatewayEnvVarName('simple')).toBe('AGENTCORE_GATEWAY_SIMPLE_URL');
  });
});

describe('computeDefaultMcpRuntimeEnvVarName', () => {
  it('uppercases and wraps runtime name', () => {
    expect(computeDefaultMcpRuntimeEnvVarName('my-runtime')).toBe('AGENTCORE_MCPRUNTIME_MY_RUNTIME_URL');
  });

  it('replaces hyphens with underscores', () => {
    expect(computeDefaultMcpRuntimeEnvVarName('a-b-c')).toBe('AGENTCORE_MCPRUNTIME_A_B_C_URL');
  });

  it('handles name with no hyphens', () => {
    expect(computeDefaultMcpRuntimeEnvVarName('runtime')).toBe('AGENTCORE_MCPRUNTIME_RUNTIME_URL');
  });
});
