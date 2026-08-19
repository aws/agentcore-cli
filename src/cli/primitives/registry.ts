import { AgentPrimitive } from './AgentPrimitive';
import type { BasePrimitive } from './BasePrimitive';
import { CapacityProviderPrimitive } from './CapacityProviderPrimitive';
import { ConfigBundlePrimitive } from './ConfigBundlePrimitive';
import { CredentialPrimitive } from './CredentialPrimitive';
import { DatasetPrimitive } from './DatasetPrimitive';
import { EvaluatorPrimitive } from './EvaluatorPrimitive';
import { GatewayPrimitive } from './GatewayPrimitive';
import { GatewayTargetPrimitive } from './GatewayTargetPrimitive';
import { HarnessPrimitive } from './HarnessPrimitive';
import { KnowledgeBasePrimitive } from './KnowledgeBasePrimitive';
import { MemoryPrimitive } from './MemoryPrimitive';
import { OnlineEvalConfigPrimitive } from './OnlineEvalConfigPrimitive';
import { OnlineInsightsPrimitive } from './OnlineInsightsPrimitive';
import { PaymentConnectorPrimitive } from './PaymentConnectorPrimitive';
import { PaymentManagerPrimitive } from './PaymentManagerPrimitive';
import { PolicyEnginePrimitive } from './PolicyEnginePrimitive';
import { PolicyPrimitive } from './PolicyPrimitive';
import { RuntimeEndpointPrimitive } from './RuntimeEndpointPrimitive';
import type { RemovableResource } from './types';

/**
 * Singleton instances of all primitives.
 */
export const agentPrimitive = new AgentPrimitive();
export const harnessPrimitive = new HarnessPrimitive();
export const memoryPrimitive = new MemoryPrimitive();
export const datasetPrimitive = new DatasetPrimitive();
export const credentialPrimitive = new CredentialPrimitive();
export const evaluatorPrimitive = new EvaluatorPrimitive();
export const onlineEvalConfigPrimitive = new OnlineEvalConfigPrimitive();
export const onlineInsightsPrimitive = new OnlineInsightsPrimitive();
export const gatewayPrimitive = new GatewayPrimitive();
export const gatewayTargetPrimitive = new GatewayTargetPrimitive();
export const knowledgeBasePrimitive = new KnowledgeBasePrimitive();
export const policyEnginePrimitive = new PolicyEnginePrimitive();
export const policyPrimitive = new PolicyPrimitive();
export const configBundlePrimitive = new ConfigBundlePrimitive();
export const runtimeEndpointPrimitive = new RuntimeEndpointPrimitive();
export const paymentManagerPrimitive = new PaymentManagerPrimitive();
export const paymentConnectorPrimitive = new PaymentConnectorPrimitive();
export const capacityProviderPrimitive = new CapacityProviderPrimitive();

/**
 * All primitives in display order.
 */
export const ALL_PRIMITIVES: BasePrimitive<unknown, RemovableResource>[] = [
  agentPrimitive,
  harnessPrimitive,
  memoryPrimitive,
  datasetPrimitive,
  credentialPrimitive,
  evaluatorPrimitive,
  onlineEvalConfigPrimitive,
  onlineInsightsPrimitive,
  gatewayPrimitive,
  gatewayTargetPrimitive,
  knowledgeBasePrimitive,
  policyEnginePrimitive,
  policyPrimitive,
  configBundlePrimitive,
  runtimeEndpointPrimitive,
  paymentManagerPrimitive,
  paymentConnectorPrimitive,
  capacityProviderPrimitive,
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
