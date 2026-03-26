import { AgentPrimitive } from './AgentPrimitive';
import type { BasePrimitive } from './BasePrimitive';
import { CredentialPrimitive } from './CredentialPrimitive';
import { EvaluatorPrimitive } from './EvaluatorPrimitive';
import { GatewayPrimitive } from './GatewayPrimitive';
import { GatewayTargetPrimitive } from './GatewayTargetPrimitive';
import { MemoryPrimitive } from './MemoryPrimitive';
import { OnlineEvalConfigPrimitive } from './OnlineEvalConfigPrimitive';
import { PolicyEnginePrimitive } from './PolicyEnginePrimitive';
import { PolicyPrimitive } from './PolicyPrimitive';
import type { RemovableResource } from './types';

/**
 * Singleton instances of all primitives.
 */
export const agentPrimitive = new AgentPrimitive();
export const memoryPrimitive = new MemoryPrimitive();
export const credentialPrimitive = new CredentialPrimitive();
export const evaluatorPrimitive = new EvaluatorPrimitive();
export const onlineEvalConfigPrimitive = new OnlineEvalConfigPrimitive();
export const gatewayPrimitive = new GatewayPrimitive();
export const gatewayTargetPrimitive = new GatewayTargetPrimitive();
export const policyEnginePrimitive = new PolicyEnginePrimitive();
export const policyPrimitive = new PolicyPrimitive();

/**
 * All primitives in display order.
 */
export const ALL_PRIMITIVES: BasePrimitive<unknown, RemovableResource>[] = [
  agentPrimitive,
  memoryPrimitive,
  credentialPrimitive,
  evaluatorPrimitive,
  onlineEvalConfigPrimitive,
  gatewayPrimitive,
  gatewayTargetPrimitive,
  policyEnginePrimitive,
  policyPrimitive,
];

/**
 * Look up a primitive by its kind.
 */
export function getPrimitive(kind: string): BasePrimitive<unknown, RemovableResource> {
  const primitive = ALL_PRIMITIVES.find(p => p.kind === kind);
  if (!primitive) {
    throw new Error(`Unknown primitive kind: ${kind}`);
  }
  return primitive;
}
