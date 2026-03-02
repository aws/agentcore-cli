import { GatewayPrimitive } from '../../../primitives/GatewayPrimitive.js';
import { GatewayTargetPrimitive } from '../../../primitives/GatewayTargetPrimitive.js';
import { describe, expect, it } from 'vitest';

const computeDefaultGatewayEnvVarName = (name: string) => GatewayPrimitive.computeDefaultGatewayEnvVarName(name);
const computeDefaultMcpRuntimeEnvVarName = (name: string) =>
  GatewayTargetPrimitive.computeDefaultMcpRuntimeEnvVarName(name);

describe('computeDefaultGatewayEnvVarName', () => {
  it('converts simple name to env var', () => {
    expect(computeDefaultGatewayEnvVarName('mygateway')).toBe('AGENTCORE_GATEWAY_MYGATEWAY_URL');
  });

  it('replaces hyphens with underscores', () => {
    expect(computeDefaultGatewayEnvVarName('my-gateway')).toBe('AGENTCORE_GATEWAY_MY_GATEWAY_URL');
  });
});

describe('computeDefaultMcpRuntimeEnvVarName', () => {
  it('converts simple name to env var', () => {
    expect(computeDefaultMcpRuntimeEnvVarName('myruntime')).toBe('AGENTCORE_MCPRUNTIME_MYRUNTIME_URL');
  });

  it('replaces hyphens with underscores', () => {
    expect(computeDefaultMcpRuntimeEnvVarName('my-runtime')).toBe('AGENTCORE_MCPRUNTIME_MY_RUNTIME_URL');
  });
});
