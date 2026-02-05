import type { RemovableIdentity } from '../../../operations/remove';
import { SelectScreen } from '../../components';
import React from 'react';

interface RemoveIdentityScreenProps {
  /** List of credentials that can be removed */
  identities: RemovableIdentity[];
  /** Called when a credential is selected for removal */
  onSelect: (identityName: string) => void;
  /** Called when user cancels */
  onExit: () => void;
}

export function RemoveIdentityScreen({ identities, onSelect, onExit }: RemoveIdentityScreenProps) {
  const items = identities.map(identity => ({
    id: identity.name,
    title: identity.name,
    description: identity.type,
  }));

  return (
    <SelectScreen
      title="Select Credential to Remove"
      items={items}
      onSelect={item => onSelect(item.id)}
      onExit={onExit}
    />
  );
}
