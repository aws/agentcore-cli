import { GatewayPrimitive } from '../../../primitives/GatewayPrimitive.js';
import { describe, expect, it } from 'vitest';

const computeDefaultGatewayEnvVarName = (name: string) => GatewayPrimitive.computeDefaultGatewayEnvVarName(name);

describe('computeDefaultGatewayEnvVarName', () => {
  it('converts simple name to env var', () => {
    expect(computeDefaultGatewayEnvVarName('mygateway')).toBe('AGENTCORE_GATEWAY_MYGATEWAY_URL');
  });

  it('replaces hyphens with underscores', () => {
    expect(computeDefaultGatewayEnvVarName('my-gateway')).toBe('AGENTCORE_GATEWAY_MY_GATEWAY_URL');
  });
});
