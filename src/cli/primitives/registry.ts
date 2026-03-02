import { AgentPrimitive } from './AgentPrimitive';
import type { BasePrimitive } from './BasePrimitive';
import { CredentialPrimitive } from './CredentialPrimitive';
import { GatewayPrimitive } from './GatewayPrimitive';
import { GatewayTargetPrimitive } from './GatewayTargetPrimitive';
import { MemoryPrimitive } from './MemoryPrimitive';

/**
 * Singleton instances of all primitives.
 */
export const agentPrimitive = new AgentPrimitive();
export const memoryPrimitive = new MemoryPrimitive();
export const credentialPrimitive = new CredentialPrimitive();
export const gatewayPrimitive = new GatewayPrimitive();
export const gatewayTargetPrimitive = new GatewayTargetPrimitive();

/**
 * All primitives in display order.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ALL_PRIMITIVES: BasePrimitive<any, any>[] = [
  agentPrimitive,
  memoryPrimitive,
  credentialPrimitive,
  gatewayPrimitive,
  gatewayTargetPrimitive,
];

/**
 * Look up a primitive by its kind.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getPrimitive(kind: string): BasePrimitive<any, any> {
  const primitive = ALL_PRIMITIVES.find(p => p.kind === kind);
  if (!primitive) {
    throw new Error(`Unknown primitive kind: ${kind}`);
  }
  return primitive;
}
