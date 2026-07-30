import type { AgentCoreProjectSpec } from '../../../../../schema';
import { resolveRuntimeTargetNames } from '../resolve';
import { describe, expect, it } from 'vitest';

type GatewaysOnly = Pick<AgentCoreProjectSpec, 'agentCoreGateways'>;

/** Project spec carrying only the gateway targets the resolver reads. */
function specWithTargets(targets: unknown[]): GatewaysOnly {
  return { agentCoreGateways: [{ name: 'my-gw', targets }] } as unknown as GatewaysOnly;
}

const httpTarget = (name: string, runtime: string) => ({
  name,
  targetType: 'httpRuntime',
  httpRuntime: { runtime },
});

describe('resolveRuntimeTargetNames', () => {
  it('returns the single httpRuntime target routing to the runtime', () => {
    const spec = specWithTargets([httpTarget('customer-support-ab', 'CustomerSupportAB')]);
    expect(resolveRuntimeTargetNames('my-gw', 'CustomerSupportAB', spec)).toEqual(['customer-support-ab']);
  });

  it('picks only the matching target when the gateway serves several runtimes', () => {
    const spec = specWithTargets([
      httpTarget('orders', 'OrdersAgent'),
      httpTarget('customer-support-ab', 'CustomerSupportAB'),
    ]);
    expect(resolveRuntimeTargetNames('my-gw', 'CustomerSupportAB', spec)).toEqual(['customer-support-ab']);
  });

  it('returns every matching target, in spec order, when several front one runtime', () => {
    const spec = specWithTargets([
      httpTarget('customer-support-ab', 'CustomerSupportAB'),
      httpTarget('customer-support-canary', 'CustomerSupportAB'),
    ]);
    expect(resolveRuntimeTargetNames('my-gw', 'CustomerSupportAB', spec)).toEqual([
      'customer-support-ab',
      'customer-support-canary',
    ]);
  });

  it('returns [] when no target routes to the runtime', () => {
    const spec = specWithTargets([httpTarget('orders', 'OrdersAgent')]);
    expect(resolveRuntimeTargetNames('my-gw', 'CustomerSupportAB', spec)).toEqual([]);
  });

  it('returns [] for a gateway with no targets', () => {
    expect(resolveRuntimeTargetNames('my-gw', 'CustomerSupportAB', specWithTargets([]))).toEqual([]);
  });

  // Only httpRuntime targets front a runtime; a same-named lambda/mcpServer target is not a route to it.
  it('ignores targets that are not httpRuntime', () => {
    const spec = specWithTargets([
      { name: 'customer-support-ab', targetType: 'lambda', httpRuntime: { runtime: 'CustomerSupportAB' } },
    ]);
    expect(resolveRuntimeTargetNames('my-gw', 'CustomerSupportAB', spec)).toEqual([]);
  });

  it('returns [] for an unknown gateway name', () => {
    const spec = specWithTargets([httpTarget('customer-support-ab', 'CustomerSupportAB')]);
    expect(resolveRuntimeTargetNames('other-gw', 'CustomerSupportAB', spec)).toEqual([]);
  });

  it('returns [] when the gateway or runtime is unset', () => {
    const spec = specWithTargets([httpTarget('customer-support-ab', 'CustomerSupportAB')]);
    expect(resolveRuntimeTargetNames(undefined, 'CustomerSupportAB', spec)).toEqual([]);
    expect(resolveRuntimeTargetNames('my-gw', undefined, spec)).toEqual([]);
  });

  it('returns [] when the project declares no gateways', () => {
    expect(resolveRuntimeTargetNames('my-gw', 'CustomerSupportAB', {} as GatewaysOnly)).toEqual([]);
  });
});
