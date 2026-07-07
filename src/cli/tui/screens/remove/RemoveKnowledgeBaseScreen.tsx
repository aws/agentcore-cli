import type { RemovableKnowledgeBase } from '../../../primitives/KnowledgeBasePrimitive';
import { SelectScreen } from '../../components';
import React from 'react';

interface RemoveKnowledgeBaseScreenProps {
  knowledgeBases: RemovableKnowledgeBase[];
  onSelect: (knowledgeBaseName: string) => void;
  onExit: () => void;
}

export function RemoveKnowledgeBaseScreen({ knowledgeBases, onSelect, onExit }: RemoveKnowledgeBaseScreenProps) {
  const items = knowledgeBases.map(kb => ({
    id: kb.name,
    title: kb.name,
    description: 'Knowledge Base',
  }));

  return (
    <SelectScreen
      title="Select Knowledge Base to Remove"
      items={items}
      onSelect={item => onSelect(item.id)}
      onExit={onExit}
    />
  );
}
