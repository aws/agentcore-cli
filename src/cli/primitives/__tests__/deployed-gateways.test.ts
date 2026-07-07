import type { DeployedState, TargetDeployedState } from '../../../schema';
import { findDeployedGateway, firstDeployedGateway, mergeDeployedGateways } from '../deployed-gateways';
import { describe, expect, it } from 'vitest';

const mcpGw = { gatewayId: 'mcp-id', gatewayArn: 'arn:mcp' };
const httpGw = { gatewayId: 'http-id', gatewayArn: 'arn:http' };

describe('mergeDeployedGateways', () => {
  it('returns MCP gateways stored under resources.mcp.gateways', () => {
    const target: TargetDeployedState = { resources: { mcp: { gateways: { 'mcp-gw': mcpGw } } } };
    expect(mergeDeployedGateways(target)).toEqual({ 'mcp-gw': mcpGw });
  });

  it('returns HTTP gateways stored under resources.gateways', () => {
    const target: TargetDeployedState = { resources: { gateways: { 'http-gw': httpGw } } };
    expect(mergeDeployedGateways(target)).toEqual({ 'http-gw': httpGw });
  });

  it('merges both locations when MCP and HTTP gateways coexist', () => {
    const target: TargetDeployedState = {
      resources: { mcp: { gateways: { 'mcp-gw': mcpGw } }, gateways: { 'http-gw': httpGw } },
    };
    expect(mergeDeployedGateways(target)).toEqual({ 'mcp-gw': mcpGw, 'http-gw': httpGw });
  });

  it('returns an empty record when no gateways are deployed', () => {
    expect(mergeDeployedGateways({ resources: {} })).toEqual({});
    expect(mergeDeployedGateways({})).toEqual({});
  });
});

describe('findDeployedGateway', () => {
  const state: DeployedState = {
    targets: {
      t1: { resources: { mcp: { gateways: { 'mcp-gw': mcpGw } } } },
      t2: { resources: { gateways: { 'http-gw': httpGw } } },
    },
  };

  it('finds a named MCP gateway across targets', () => {
    expect(findDeployedGateway(state, 'mcp-gw')).toEqual(mcpGw);
  });

  it('finds a named HTTP gateway across targets', () => {
    expect(findDeployedGateway(state, 'http-gw')).toEqual(httpGw);
  });

  it('returns undefined when the named gateway is absent', () => {
    expect(findDeployedGateway(state, 'missing')).toBeUndefined();
    expect(findDeployedGateway({ targets: {} }, 'anything')).toBeUndefined();
  });
});

describe('firstDeployedGateway', () => {
  it('returns the first gateway found across targets', () => {
    const state: DeployedState = { targets: { t1: { resources: { gateways: { 'http-gw': httpGw } } } } };
    expect(firstDeployedGateway(state)).toEqual(httpGw);
  });

  it('returns undefined when no gateways are deployed', () => {
    expect(firstDeployedGateway({ targets: { t1: { resources: {} } } })).toBeUndefined();
    expect(firstDeployedGateway({ targets: {} })).toBeUndefined();
  });
});
