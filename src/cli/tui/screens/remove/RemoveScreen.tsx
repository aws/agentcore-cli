import type { SelectableItem } from '../../components';
import { SelectScreen } from '../../components';
import { useMemo } from 'react';

const REMOVE_RESOURCES = [
  { id: 'agent', title: 'Agent', description: 'Remove an agent from the project' },
  { id: 'harness', title: 'Harness', description: 'Remove a harness from the project' },
  { id: 'memory', title: 'Memory', description: 'Remove a memory provider' },
  { id: 'credential', title: 'Credential', description: 'Remove a credential' },
  { id: 'evaluator', title: 'Evaluator', description: 'Remove a custom evaluator' },
  { id: 'online-eval', title: 'Online Eval Config', description: 'Remove an online eval config' },
  { id: 'policy-engine', title: 'Policy Engine', description: 'Remove a policy engine' },
  { id: 'policy', title: 'Policy', description: 'Remove a policy from a policy engine' },
  { id: 'gateway', title: 'Gateway', description: 'Remove a gateway' },
  { id: 'gateway-target', title: 'Gateway Target', description: 'Remove a gateway target' },
  { id: 'config-bundle', title: 'Configuration Bundle [preview]', description: 'Remove a configuration bundle' },
  { id: 'ab-test', title: 'AB Test [preview]', description: 'Remove an A/B test' },
  { id: 'runtime-endpoint', title: 'Runtime Endpoint', description: 'Remove a runtime endpoint' },
  { id: 'all', title: 'All', description: 'Reset entire agentcore project' },
] as const;

export type RemoveResourceType = (typeof REMOVE_RESOURCES)[number]['id'];

interface RemoveScreenProps {
  onSelect: (resourceType: RemoveResourceType) => void;
  onExit: () => void;
  /** Number of agents available for removal */
  agentCount: number;
  /** Number of harnesses available for removal */
  harnessCount: number;
  /** Number of gateways available for removal */
  gatewayCount: number;
  /** Number of gateway targets available for removal */
  mcpToolCount: number;
  /** Number of memories available for removal */
  memoryCount: number;
  /** Number of credentials available for removal */
  credentialCount: number;
  /** Number of evaluators available for removal */
  evaluatorCount: number;
  /** Number of online eval configs available for removal */
  onlineEvalCount: number;
  /** Number of policy engines available for removal */
  policyEngineCount: number;
  /** Number of policies available for removal */
  policyCount: number;
  /** Number of configuration bundles available for removal */
  configBundleCount: number;
  /** Number of AB tests available for removal */
  abTestCount: number;
  /** Number of runtime endpoints available for removal */
  runtimeEndpointCount: number;
}

export function RemoveScreen({
  onSelect,
  onExit,
  agentCount,
  harnessCount,
  gatewayCount,
  mcpToolCount,
  memoryCount,
  credentialCount,
  evaluatorCount,
  onlineEvalCount,
  policyEngineCount,
  policyCount,
  configBundleCount,
  abTestCount,
  runtimeEndpointCount,
}: RemoveScreenProps) {
  const items: SelectableItem[] = useMemo(() => {
    return REMOVE_RESOURCES.map(r => {
      let disabled = Boolean('disabled' in r && r.disabled);
      let description: string = r.description;

      switch (r.id) {
        case 'agent':
          if (agentCount === 0) {
            disabled = true;
            description = 'No agents to remove';
          }
          break;
        case 'harness':
          if (harnessCount === 0) {
            disabled = true;
            description = 'No harnesses to remove';
          }
          break;
        case 'gateway':
          if (gatewayCount === 0) {
            disabled = true;
            description = 'No gateways to remove';
          }
          break;
        case 'gateway-target':
          if (mcpToolCount === 0) {
            disabled = true;
            description = 'No gateway targets to remove';
          }
          break;
        case 'memory':
          if (memoryCount === 0) {
            disabled = true;
            description = 'No memories to remove';
          }
          break;
        case 'credential':
          if (credentialCount === 0) {
            disabled = true;
            description = 'No credentials to remove';
          }
          break;
        case 'evaluator':
          if (evaluatorCount === 0) {
            disabled = true;
            description = 'No evaluators to remove';
          }
          break;
        case 'online-eval':
          if (onlineEvalCount === 0) {
            disabled = true;
            description = 'No online eval configs to remove';
          }
          break;
        case 'policy-engine':
          if (policyEngineCount === 0) {
            disabled = true;
            description = 'No policy engines to remove';
          }
          break;
        case 'policy':
          if (policyCount === 0) {
            disabled = true;
            description = 'No policies to remove';
          }
          break;
        case 'config-bundle':
          if (configBundleCount === 0) {
            disabled = true;
            description = 'No configuration bundles to remove';
          }
          break;
        case 'ab-test':
          if (abTestCount === 0) {
            disabled = true;
            description = 'No AB tests to remove';
          }
          break;
        case 'runtime-endpoint':
          if (runtimeEndpointCount === 0) {
            disabled = true;
            description = 'No runtime endpoints to remove';
          }
          break;
        case 'all':
          // 'all' is always available
          break;
      }

      return { ...r, disabled, description };
    });
  }, [
    agentCount,
    harnessCount,
    gatewayCount,
    mcpToolCount,
    memoryCount,
    credentialCount,
    evaluatorCount,
    onlineEvalCount,
    policyEngineCount,
    policyCount,
    configBundleCount,
    abTestCount,
    runtimeEndpointCount,
  ]);

  const isDisabled = (item: SelectableItem) => item.disabled ?? false;

  return (
    <SelectScreen
      title="Remove Resource"
      items={items}
      onSelect={item => onSelect(item.id as RemoveResourceType)}
      onExit={onExit}
      isDisabled={isDisabled}
    />
  );
}
