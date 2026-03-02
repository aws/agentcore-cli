import {
  type AgentCoreGateway,
  type AgentCoreGatewayTarget,
  type AgentCoreMcpSpec,
  AgentCoreMcpSpecSchema,
  GatewayNameSchema,
  type OutboundAuth,
} from '../../../../schema';
import { Header, Panel, ScreenLayout, TextInput } from '../../components';
import { useSchemaDocument } from '../../hooks/useSchemaDocument';
import { diffLines } from '../../utils';
import { Box, Text, useInput } from 'ink';
import React, { useState } from 'react';

interface SchemaOption {
  id: string;
  title: string;
  filePath: string;
}

interface McpGuidedEditorProps {
  schema: SchemaOption;
  onBack: () => void;
  onRequestAdd?: () => void;
}

export function McpGuidedEditor(props: McpGuidedEditorProps) {
  const { content, status, save } = useSchemaDocument(props.schema.filePath, AgentCoreMcpSpecSchema);

  if (status.status === 'loading') {
    return (
      <ScreenLayout onExit={props.onBack}>
        <Header title="Edit MCP Config" subtitle="Loading..." />
        <Text dimColor>Loading MCP config from disk.</Text>
      </ScreenLayout>
    );
  }

  if (status.status === 'error') {
    return (
      <ScreenLayout onExit={props.onBack}>
        <Header title="Edit MCP Config" subtitle="Error" />
        <Box flexDirection="column">
          <Text color="red">Unable to load mcp.json</Text>
          <Text dimColor>{status.message ?? 'Unknown error'}</Text>
          <Text dimColor>Esc back</Text>
        </Box>
      </ScreenLayout>
    );
  }

  let mcpSpec: AgentCoreMcpSpec & { unassignedTargets?: AgentCoreGatewayTarget[] } = {
    agentCoreGateways: [],
    unassignedTargets: [],
  };
  try {
    const parsed: unknown = JSON.parse(content);
    const result = AgentCoreMcpSpecSchema.safeParse(parsed);
    if (result.success) {
      mcpSpec = result.data;
    }
  } catch {
    // Will show empty gateways
  }

  const baseline = JSON.stringify(mcpSpec, null, 2);

  return (
    <McpEditorBody
      key={content}
      schema={props.schema}
      initialSpec={mcpSpec}
      baseline={baseline}
      onBack={props.onBack}
      onSave={save}
      onRequestAdd={props.onRequestAdd}
    />
  );
}

// Gateways view is the only view mode
type ScreenMode = 'list' | 'confirm-exit' | 'edit-item' | 'edit-field' | 'edit-targets' | 'edit-target-field';

function McpEditorBody(props: {
  schema: SchemaOption;
  initialSpec: AgentCoreMcpSpec & { unassignedTargets?: AgentCoreGatewayTarget[] };
  baseline: string;
  onBack: () => void;
  onSave: (content: string) => Promise<{ ok: boolean; error?: string }>;
  onRequestAdd?: () => void;
}) {
  const [gateways, setGateways] = useState<AgentCoreGateway[]>(props.initialSpec.agentCoreGateways);
  const [unassignedTargets, setUnassignedTargets] = useState<AgentCoreGatewayTarget[]>(
    props.initialSpec.unassignedTargets ?? []
  );
  // Only gateways view mode
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [screenMode, setScreenMode] = useState<ScreenMode>('list');
  const [saveError, setSaveError] = useState<string | null>(null);
  // Edit item state
  const [editFieldIndex, setEditFieldIndex] = useState(0);
  const [editingFieldId, setEditingFieldId] = useState<string | null>(null);
  // Target editing state
  const [selectedTargetIndex, setSelectedTargetIndex] = useState(0);
  const [editingTargetFieldId, setEditingTargetFieldId] = useState<string | null>(null);
  // Unassigned target assignment state
  const [selectedUnassignedIndex, setSelectedUnassignedIndex] = useState(0);
  const [assigningTarget, setAssigningTarget] = useState(false);

  // Define editable fields for the current item
  const currentGateway = gateways[selectedIndex];
  const targetCount = currentGateway?.targets?.length ?? 0;
  const gatewayFields = [
    { id: 'name', label: 'Name' },
    { id: 'description', label: 'Description' },
    { id: 'targets', label: `Targets (${targetCount})` },
  ];
  const currentFields = gatewayFields;

  // Target fields
  const currentTarget = currentGateway?.targets?.[selectedTargetIndex];
  const targetFields = [
    { id: 'targetName', label: 'Target Name' },
    { id: 'targetType', label: 'Target Type' },
    ...(currentTarget?.targetType === 'mcpServer' ? [{ id: 'endpoint', label: 'Endpoint URL' }] : []),
    { id: 'outboundAuth', label: 'Outbound Auth' },
  ];

  async function commitChanges() {
    const spec: AgentCoreMcpSpec & { unassignedTargets?: AgentCoreGatewayTarget[] } = {
      agentCoreGateways: gateways,
      ...(unassignedTargets.length > 0 ? { unassignedTargets: unassignedTargets } : {}),
    };
    const content = JSON.stringify(spec, null, 2);
    const result = await props.onSave(content);
    if (result.ok) {
      props.onBack();
    } else {
      setSaveError(result.error ?? 'Failed to save');
    }
  }

  function assignTargetToGateway(targetIndex: number, gatewayIndex: number) {
    const target = unassignedTargets[targetIndex];
    if (!target) return;

    // Remove from unassigned targets
    const newUnassignedTargets = unassignedTargets.filter((_, idx) => idx !== targetIndex);
    setUnassignedTargets(newUnassignedTargets);

    // Add to selected gateway
    const newGateways = gateways.map((gateway, idx) => {
      if (idx === gatewayIndex) {
        return {
          ...gateway,
          targets: [...gateway.targets, target],
        };
      }
      return gateway;
    });
    setGateways(newGateways);
    setDirty(true);
  }

  useInput((input, key) => {
    // Handle confirm-exit screen
    if (screenMode === 'confirm-exit') {
      if (input.toLowerCase() === 'y') {
        void commitChanges();
        return;
      }
      if (input.toLowerCase() === 'n' || key.escape) {
        props.onBack(); // Discard and exit
        return;
      }
      return;
    }

    // Handle edit-item screen (field selection)
    if (screenMode === 'edit-item') {
      if (key.escape) {
        setScreenMode('list');
        return;
      }
      if (key.upArrow) {
        setEditFieldIndex(idx => Math.max(0, idx - 1));
        return;
      }
      if (key.downArrow) {
        setEditFieldIndex(idx => Math.min(currentFields.length - 1, idx + 1));
        return;
      }
      if (key.return) {
        const field = currentFields[editFieldIndex];
        if (field) {
          if (field.id === 'targets') {
            // Go to targets list
            setSelectedTargetIndex(0);
            setScreenMode('edit-targets');
          } else {
            setEditingFieldId(field.id);
            setScreenMode('edit-field');
          }
        }
        return;
      }
      return;
    }

    // Handle edit-field screen (text input handles its own input)
    if (screenMode === 'edit-field') {
      return;
    }

    // Handle edit-targets screen (target selection)
    if (screenMode === 'edit-targets') {
      const targets = currentGateway?.targets ?? [];
      if (key.escape) {
        setScreenMode('edit-item');
        return;
      }
      if (key.upArrow && targets.length > 0) {
        setSelectedTargetIndex(idx => Math.max(0, idx - 1));
        return;
      }
      if (key.downArrow && targets.length > 0) {
        setSelectedTargetIndex(idx => Math.min(targets.length - 1, idx + 1));
        return;
      }
      if (key.return && targets.length > 0) {
        setEditingTargetFieldId('targetName');
        setScreenMode('edit-target-field');
        return;
      }
      return;
    }

    // Handle edit-target-field screen (text input handles its own input)
    if (screenMode === 'edit-target-field') {
      return;
    }

    // List mode keys
    if (key.escape) {
      if (assigningTarget) {
        setAssigningTarget(false);
        return;
      }
      if (expandedIndex !== null) {
        setExpandedIndex(null);
        return;
      }
      if (dirty) {
        setScreenMode('confirm-exit');
        return;
      }
      props.onBack();
      return;
    }

    // Handle unassigned target assignment mode
    if (assigningTarget) {
      if (key.upArrow && gateways.length > 0) {
        setSelectedIndex(idx => Math.max(0, idx - 1));
        return;
      }
      if (key.downArrow && gateways.length > 0) {
        setSelectedIndex(idx => Math.min(gateways.length - 1, idx + 1));
        return;
      }
      if (key.return && gateways.length > 0) {
        assignTargetToGateway(selectedUnassignedIndex, selectedIndex);
        setAssigningTarget(false);
        setSelectedUnassignedIndex(0);
        return;
      }
      return;
    }

    // Handle unassigned targets navigation (when not in assignment mode)
    if (unassignedTargets.length > 0) {
      // U key to focus unassigned targets
      if (input.toLowerCase() === 'u') {
        setSelectedUnassignedIndex(0);
        return;
      }

      // When focused on unassigned targets, use left/right arrows to navigate
      if (key.leftArrow && unassignedTargets.length > 0) {
        setSelectedUnassignedIndex(idx => Math.max(0, idx - 1));
        return;
      }
      if (key.rightArrow && unassignedTargets.length > 0) {
        setSelectedUnassignedIndex(idx => Math.min(unassignedTargets.length - 1, idx + 1));
        return;
      }

      // Enter to start assignment when focused on unassigned target
      if (key.return && selectedUnassignedIndex < unassignedTargets.length) {
        setAssigningTarget(true);
        setSelectedIndex(0);
        return;
      }
    }

    // A to add (works in both views)
    if (input.toLowerCase() === 'a' && props.onRequestAdd) {
      props.onRequestAdd();
      return;
    }

    // View-specific navigation and actions
    const items = gateways;
    const itemCount = items.length;

    if (key.upArrow && itemCount > 0) {
      setSelectedIndex(idx => (idx - 1 + itemCount) % itemCount);
      return;
    }

    if (key.downArrow && itemCount > 0) {
      setSelectedIndex(idx => (idx + 1) % itemCount);
      return;
    }

    // Space to toggle expand (show targets/details)
    if (input === ' ' && itemCount > 0) {
      setExpandedIndex(prev => (prev === selectedIndex ? null : selectedIndex));
      return;
    }

    // Enter to edit the selected item
    if (key.return && itemCount > 0) {
      setEditFieldIndex(0);
      setScreenMode('edit-item');
      return;
    }

    // D to delete
    if (input.toLowerCase() === 'd' && itemCount > 0) {
      const next = gateways.filter((_, idx) => idx !== selectedIndex);
      setGateways(next);
      setSelectedIndex(prev => Math.max(0, Math.min(prev, itemCount - 2)));
      setExpandedIndex(null);
      setDirty(true);
      return;
    }
  });

  // Edit item screen - shows list of editable fields
  if (screenMode === 'edit-item') {
    const currentGateway = gateways[selectedIndex];
    const itemName = currentGateway?.name ?? 'Unknown';

    return (
      <ScreenLayout>
        <Header title="Edit Gateway" subtitle={itemName} />
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>↑↓ navigate · Enter edit · Esc back</Text>
          <Box marginTop={1} flexDirection="column">
            {currentFields.map((field, idx) => {
              const selected = idx === editFieldIndex;
              let value = '';
              if (currentGateway) {
                if (field.id === 'name') value = currentGateway.name;
                if (field.id === 'description') value = currentGateway.description ?? '';
              }
              return (
                <Box key={field.id} gap={1}>
                  <Text color={selected ? 'cyan' : undefined}>{selected ? '❯' : ' '}</Text>
                  <Box width={14}>
                    <Text bold={selected} color={selected ? 'cyan' : undefined}>
                      {field.label}
                    </Text>
                  </Box>
                  <Text dimColor>{value || '(empty)'}</Text>
                </Box>
              );
            })}
          </Box>
        </Box>
      </ScreenLayout>
    );
  }

  // Edit field screen - text input for the selected field
  if (screenMode === 'edit-field' && editingFieldId) {
    const currentGateway = gateways[selectedIndex];
    const field = currentFields.find(f => f.id === editingFieldId);

    if (!field) {
      setScreenMode('edit-item');
      return null;
    }

    let initialValue = '';
    if (currentGateway) {
      if (editingFieldId === 'name') initialValue = currentGateway.name;
      if (editingFieldId === 'description') initialValue = currentGateway.description ?? '';
    }

    const handleSubmit = (value: string) => {
      if (editingFieldId === 'name') {
        const next = gateways.map((g, idx) => (idx === selectedIndex ? { ...g, name: value } : g));
        setGateways(next);
      } else if (editingFieldId === 'description') {
        const next = gateways.map((g, idx) => (idx === selectedIndex ? { ...g, description: value || undefined } : g));
        setGateways(next);
      }
      setDirty(true);
      setEditingFieldId(null);
      setScreenMode('edit-item');
    };

    const isGatewayName = editingFieldId === 'name';

    // Get existing names (excluding current) for uniqueness check
    let existingNames: string[] = [];
    if (isGatewayName) {
      existingNames = gateways.filter((_, idx) => idx !== selectedIndex).map(g => g.name);
    }

    const customValidation = isGatewayName
      ? (value: string) => !existingNames.includes(value) || 'Gateway name already exists'
      : undefined;

    return (
      <ScreenLayout>
        <Header title={`Edit ${field.label}`} subtitle={props.schema.title} />
        <Box marginTop={1}>
          <TextInput
            prompt={field.label}
            initialValue={initialValue}
            placeholder={editingFieldId === 'description' ? 'Optional description' : undefined}
            schema={isGatewayName ? GatewayNameSchema : undefined}
            customValidation={customValidation}
            onSubmit={handleSubmit}
            onCancel={() => {
              setEditingFieldId(null);
              setScreenMode('edit-item');
            }}
          />
        </Box>
      </ScreenLayout>
    );
  }

  // Edit targets screen - shows list of targets in the current gateway
  if (screenMode === 'edit-targets') {
    const gateway = gateways[selectedIndex];
    const targets = gateway?.targets ?? [];

    return (
      <ScreenLayout>
        <Header title="Edit Targets" subtitle={gateway?.name ?? 'Gateway'} />
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>↑↓ navigate · Enter edit · Esc back</Text>
          <Box marginTop={1} flexDirection="column">
            {targets.length === 0 ? (
              <Text dimColor>No targets configured for this gateway.</Text>
            ) : (
              targets.map((target, idx) => {
                const selected = idx === selectedTargetIndex;
                const targetName = target.name ?? `Target ${idx + 1}`;
                const toolCount = target.toolDefinitions?.length ?? 0;
                const targetType = target.targetType;
                const endpoint = target.endpoint;
                const displayInfo = endpoint ?? target.compute?.host ?? targetType;
                return (
                  <Box key={idx} gap={1}>
                    <Text color={selected ? 'cyan' : undefined}>{selected ? '❯' : ' '}</Text>
                    <Text bold={selected} color={selected ? 'cyan' : undefined}>
                      {targetName}
                    </Text>
                    <Text dimColor>
                      ({toolCount} tools · {targetType} · {displayInfo})
                    </Text>
                  </Box>
                );
              })
            )}
          </Box>
        </Box>
      </ScreenLayout>
    );
  }

  // Edit target field screen - text input for the selected target field
  if (screenMode === 'edit-target-field' && editingTargetFieldId) {
    const gateway = gateways[selectedIndex];
    const target = gateway?.targets?.[selectedTargetIndex];
    const field = targetFields.find(f => f.id === editingTargetFieldId);

    if (!field || !target) {
      setScreenMode('edit-targets');
      return null;
    }

    let initialValue = '';
    if (editingTargetFieldId === 'targetName') {
      initialValue = target.name ?? '';
    } else if (editingTargetFieldId === 'targetType') {
      initialValue = target.targetType ?? '';
    } else if (editingTargetFieldId === 'endpoint') {
      initialValue = target.endpoint ?? '';
    } else if (editingTargetFieldId === 'outboundAuth') {
      const auth = target.outboundAuth;
      initialValue = auth ? `${auth.type}${auth.credentialName ? `:${auth.credentialName}` : ''}` : 'NONE';
    }

    const handleSubmit = (value: string) => {
      if (gateway) {
        const updatedTargets = [...(gateway.targets ?? [])];
        const targetToUpdate = updatedTargets[selectedTargetIndex];
        if (targetToUpdate) {
          if (editingTargetFieldId === 'targetName') {
            updatedTargets[selectedTargetIndex] = { ...targetToUpdate, name: value };
          } else if (editingTargetFieldId === 'targetType') {
            const validTypes = ['mcpServer', 'lambda', 'openApiSchema', 'smithyModel'] as const;
            const targetType = validTypes.includes(value as (typeof validTypes)[number])
              ? (value as (typeof validTypes)[number])
              : targetToUpdate.targetType;
            updatedTargets[selectedTargetIndex] = { ...targetToUpdate, targetType };
          } else if (editingTargetFieldId === 'endpoint') {
            updatedTargets[selectedTargetIndex] = { ...targetToUpdate, endpoint: value || undefined };
          } else if (editingTargetFieldId === 'outboundAuth') {
            const [type, credentialName] = value.split(':');
            const validAuthTypes = ['NONE', 'OAUTH', 'API_KEY'] as const;
            const authType = validAuthTypes.includes(type as (typeof validAuthTypes)[number])
              ? (type as (typeof validAuthTypes)[number])
              : 'NONE';
            const outboundAuth: OutboundAuth = {
              type: authType,
              ...(credentialName ? { credentialName } : {}),
            };
            updatedTargets[selectedTargetIndex] = { ...targetToUpdate, outboundAuth };
          }
          const next = gateways.map((g, idx) => (idx === selectedIndex ? { ...g, targets: updatedTargets } : g));
          setGateways(next);
          setDirty(true);
        }
      }
      setEditingTargetFieldId(null);
      setScreenMode('edit-targets');
    };

    return (
      <ScreenLayout>
        <Header title={`Edit ${field.label}`} subtitle={target.name ?? 'Target'} />
        <Box marginTop={1}>
          <TextInput
            prompt={field.label}
            initialValue={initialValue}
            placeholder={
              editingTargetFieldId === 'targetName'
                ? 'Target name'
                : editingTargetFieldId === 'targetType'
                  ? 'lambda, mcpServer, openApiSchema, smithyModel'
                  : editingTargetFieldId === 'endpoint'
                    ? 'https://example.com/mcp'
                    : editingTargetFieldId === 'outboundAuth'
                      ? 'NONE, API_KEY:credName, OAUTH:credName'
                      : undefined
            }
            onSubmit={handleSubmit}
            onCancel={() => {
              setEditingTargetFieldId(null);
              setScreenMode('edit-targets');
            }}
          />
        </Box>
      </ScreenLayout>
    );
  }

  // Confirm exit screen
  if (screenMode === 'confirm-exit') {
    const spec: AgentCoreMcpSpec & { unassignedTargets?: AgentCoreGatewayTarget[] } = {
      agentCoreGateways: gateways,
      ...(unassignedTargets.length > 0 ? { unassignedTargets: unassignedTargets } : {}),
    };
    const currentText = JSON.stringify(spec, null, 2);
    const diffOps = diffLines(props.baseline.split('\n'), currentText.split('\n'));
    const changedLines = diffOps.filter(line => line.color);

    return (
      <ScreenLayout>
        <Header title="Unsaved Changes" subtitle={props.schema.title} />
        <Box flexDirection="column" gap={1}>
          <Text>You have unsaved changes. What would you like to do?</Text>

          <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
            {changedLines.length === 0 ? (
              <Text dimColor>No changes to save.</Text>
            ) : (
              changedLines.slice(0, 10).map((line, idx) => (
                <Text key={`${line.value}-${idx}`} color={line.color}>
                  {line.prefix} {line.value}
                </Text>
              ))
            )}
            {changedLines.length > 10 && <Text dimColor>... {changedLines.length - 10} more lines</Text>}
          </Box>

          {saveError && <Text color="red">{saveError}</Text>}

          <Box gap={2}>
            <Text color="cyan" bold>
              Y
            </Text>
            <Text>Commit changes</Text>
          </Box>
          <Box gap={2}>
            <Text color="cyan" bold>
              N
            </Text>
            <Text>Discard changes</Text>
          </Box>
        </Box>
      </ScreenLayout>
    );
  }

  return (
    <ScreenLayout>
      <Header title="Edit MCP Config" subtitle={props.schema.title} />
      <Box flexDirection="column">
        <Text dimColor>A add · D del · Space expand · Enter edit · Esc back</Text>
      </Box>

      <Box marginTop={1}>
        <Panel title={`Gateways (${gateways.length})`} fullWidth>
          {gateways.length === 0 ? (
            <Text dimColor>No gateways configured. Press A to add one.</Text>
          ) : (
            <Box flexDirection="column">
              {gateways.map((gateway, idx) => {
                const selected = idx === selectedIndex;
                const expanded = expandedIndex === idx;
                const targetCount = gateway.targets?.length ?? 0;
                return (
                  <Box key={gateway.name} flexDirection="column">
                    <Box flexDirection="row" gap={1}>
                      <Text color={selected ? 'cyan' : undefined}>{selected ? '>' : ' '}</Text>
                      <Text color={selected ? 'cyan' : undefined}>{expanded ? '▼' : '▶'}</Text>
                      <Text bold={selected} color={selected ? 'cyan' : undefined}>
                        {gateway.name}
                      </Text>
                      <Text dimColor>
                        ({targetCount} {targetCount === 1 ? 'target' : 'targets'})
                      </Text>
                      {gateway.description && <Text dimColor>· {gateway.description}</Text>}
                    </Box>
                    {expanded && (
                      <Box flexDirection="column" marginLeft={4} marginTop={0}>
                        {targetCount === 0 ? (
                          <Text dimColor italic>
                            No targets defined
                          </Text>
                        ) : (
                          gateway.targets.map((target, tIdx) => (
                            <Box key={tIdx} flexDirection="row" gap={1}>
                              <Text dimColor>·</Text>
                              <Text>{target.name ?? `Target ${tIdx + 1}`}</Text>
                              <Text dimColor>
                                ({target.toolDefinitions?.length ?? 0} tools ·{' '}
                                {target.compute?.host ?? target.targetType})
                              </Text>
                            </Box>
                          ))
                        )}
                      </Box>
                    )}
                  </Box>
                );
              })}
            </Box>
          )}
        </Panel>
      </Box>

      {/* Unassigned Targets */}
      {unassignedTargets.length > 0 && (
        <Box marginTop={1}>
          <Panel title={`⚠ Unassigned Targets (${unassignedTargets.length})`} fullWidth>
            <Box flexDirection="column">
              {assigningTarget && (
                <Box marginBottom={1}>
                  <Text color="cyan">
                    Assign &quot;{unassignedTargets[selectedUnassignedIndex]?.name}&quot; to gateway:
                  </Text>
                </Box>
              )}
              {assigningTarget
                ? // Show gateway selection for assignment
                  gateways.map((gateway, idx) => (
                    <Box key={idx} flexDirection="row" gap={1}>
                      <Text color={idx === selectedIndex ? 'cyan' : 'white'}>{idx === selectedIndex ? '>' : ' '}</Text>
                      <Text color={idx === selectedIndex ? 'cyan' : 'white'}>{gateway.name}</Text>
                    </Box>
                  ))
                : // Show unassigned targets
                  unassignedTargets.map((target, idx) => {
                    const targetName = target.name ?? `Target ${idx + 1}`;
                    const targetType = target.targetType;
                    const endpoint = target.endpoint;
                    const displayInfo = endpoint ?? target.compute?.host ?? targetType;
                    const isSelected = idx === selectedUnassignedIndex;
                    return (
                      <Box key={idx} flexDirection="row" gap={1}>
                        <Text color="yellow">⚠</Text>
                        <Text color={isSelected ? 'cyan' : 'yellow'}>
                          {isSelected ? '>' : ' '} {targetName}
                        </Text>
                        <Text dimColor>
                          ({targetType} · {displayInfo})
                        </Text>
                      </Box>
                    );
                  })}
              {!assigningTarget && unassignedTargets.length > 0 && (
                <Box marginTop={1}>
                  <Text dimColor>U select · ←→ navigate · Enter assign</Text>
                </Box>
              )}
              {assigningTarget && (
                <Box marginTop={1}>
                  <Text dimColor>↑↓ select gateway · Enter confirm · Esc cancel</Text>
                </Box>
              )}
            </Box>
          </Panel>
        </Box>
      )}

      {dirty && (
        <Box marginTop={1}>
          <Text color="yellow">● Changes pending</Text>
        </Box>
      )}
    </ScreenLayout>
  );
}
