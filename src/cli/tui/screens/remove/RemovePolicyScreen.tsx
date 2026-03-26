import { SelectScreen } from '../../components';
import type { RemovablePolicyResource } from '../../hooks/useRemove';
import React from 'react';

interface RemovePolicyScreenProps {
  /** List of policies that can be removed */
  policies: RemovablePolicyResource[];
  /** Called when a policy is selected for removal (receives composite key) */
  onSelect: (compositeKey: string) => void;
  /** Called when user cancels */
  onExit: () => void;
}

export function RemovePolicyScreen({ policies, onSelect, onExit }: RemovePolicyScreenProps) {
  const items = policies.map(policy => {
    const policyName = policy.name.includes('/') ? policy.name.slice(policy.name.indexOf('/') + 1) : policy.name;
    return {
      id: policy.name,
      title: policyName,
      description: `Engine: ${policy.engineName}`,
    };
  });

  return (
    <SelectScreen title="Select Policy to Remove" items={items} onSelect={item => onSelect(item.id)} onExit={onExit} />
  );
}
