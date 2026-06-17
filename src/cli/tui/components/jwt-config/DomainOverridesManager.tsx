import { useListNavigation } from '../../hooks';
import type { SelectableItem } from '../index';
import { TextInput } from '../index';
import type { DomainOverrideEntry, DomainOverridesManagerMode } from './types';
import { formatOverrideSummary } from './types';
import { Box, Text } from 'ink';
import React, { useCallback, useMemo, useState } from 'react';

const MAX_OVERRIDES = 5;
const RCFG_PATTERN =
  /^((rcfg-[0-9a-z]{17})|(arn:[a-z0-9-]+:vpc-lattice:[a-zA-Z0-9-]+:\d{12}:resourceconfiguration\/rcfg-[0-9a-z]{17}))$/;

export interface DomainOverridesManagerProps {
  initialOverrides: DomainOverrideEntry[];
  onDone: (overrides: DomainOverrideEntry[]) => void;
  onCancel: () => void;
  onModeChange?: (mode: DomainOverridesManagerMode) => void;
}

/**
 * Repeatable list of per-domain private-endpoint overrides (Lattice-only). Mirrors
 * CustomClaimsManager's list/add/edit/delete mode machine; each entry is a {domain, rcfg-id} pair.
 * Only offered under the self-managed (VPC Lattice) arm, so every override is a lattice resource —
 * which is exactly what the service and the AWS Console expose.
 */
export function DomainOverridesManager({
  initialOverrides,
  onDone,
  onCancel,
  onModeChange,
}: DomainOverridesManagerProps) {
  const [overrides, setOverrides] = useState<DomainOverrideEntry[]>(initialOverrides);
  const [mode, setMode] = useState<DomainOverridesManagerMode>(initialOverrides.length > 0 ? 'list' : 'add');
  const [editIndex, setEditIndex] = useState(-1);
  // Two-field form: capture the domain, then the rcfg id.
  const [formField, setFormField] = useState<'domain' | 'rcfg'>('domain');
  const [draftDomain, setDraftDomain] = useState('');

  React.useEffect(() => {
    onModeChange?.(mode);
  }, [mode, onModeChange]);

  const atLimit = overrides.length >= MAX_OVERRIDES;

  const actionItems = useMemo<SelectableItem[]>(() => {
    const items: SelectableItem[] = [];
    if (!atLimit) items.push({ id: 'add', title: 'Add domain override' });
    if (overrides.length > 0) {
      items.push({ id: 'edit', title: 'Edit existing override' });
      items.push({ id: 'delete', title: 'Delete override' });
    }
    items.push({ id: 'done', title: 'Done' });
    return items;
  }, [overrides.length, atLimit]);

  const startAdd = useCallback(() => {
    setEditIndex(-1);
    setDraftDomain('');
    setFormField('domain');
    setMode('add');
  }, []);

  const actionNav = useListNavigation({
    items: actionItems,
    onSelect: item => {
      if (item.id === 'add') startAdd();
      else if (item.id === 'edit') setMode('edit-pick');
      else if (item.id === 'delete') setMode('delete-pick');
      else if (item.id === 'done') onDone(overrides);
    },
    onExit: onCancel,
    isActive: mode === 'list',
  });

  const pickerItems = useMemo<SelectableItem[]>(
    () => overrides.map((o, i) => ({ id: String(i), title: formatOverrideSummary(o) })),
    [overrides]
  );

  const editPickerNav = useListNavigation({
    items: pickerItems,
    onSelect: (_, index) => {
      setEditIndex(index);
      setDraftDomain(overrides[index]?.domain ?? '');
      setFormField('domain');
      setMode('edit');
    },
    onExit: () => setMode('list'),
    isActive: mode === 'edit-pick',
  });

  const deletePickerNav = useListNavigation({
    items: pickerItems,
    onSelect: (_, index) => {
      setOverrides(prev => {
        const next = prev.filter((_, i) => i !== index);
        setMode(next.length === 0 ? 'add' : 'list');
        return next;
      });
    },
    onExit: () => setMode('list'),
    isActive: mode === 'delete-pick',
  });

  const isFormMode = mode === 'add' || mode === 'edit';

  const cancelForm = useCallback(() => {
    if (overrides.length > 0) setMode('list');
    else onCancel();
  }, [overrides.length, onCancel]);

  const submitOverride = useCallback(
    (rcfg: string) => {
      const entry: DomainOverrideEntry = { domain: draftDomain.trim(), resourceConfigurationId: rcfg.trim() };
      if (mode === 'edit' && editIndex >= 0) {
        setOverrides(prev => prev.map((o, i) => (i === editIndex ? entry : o)));
      } else {
        setOverrides(prev => [...prev, entry]);
      }
      setEditIndex(-1);
      setMode('list');
    },
    [draftDomain, mode, editIndex]
  );

  return (
    <Box flexDirection="column">
      <Text bold>Per-domain private-endpoint overrides (optional)</Text>
      <Text dimColor>
        Map an additional IdP domain (e.g. a private jwks_uri) to its own VPC Lattice resource — up to {MAX_OVERRIDES}.
      </Text>

      {mode === 'list' && (
        <Box flexDirection="column">
          {overrides.length > 0 && (
            <Box marginTop={1} flexDirection="column">
              {overrides.map((o, i) => (
                <Text key={i} dimColor>
                  {i + 1}. {formatOverrideSummary(o)}
                </Text>
              ))}
            </Box>
          )}
          <Box marginTop={1} flexDirection="column">
            {actionItems.map((item, idx) => {
              const isCursor = idx === actionNav.selectedIndex;
              return (
                <Text key={item.id} color={isCursor ? 'cyan' : undefined}>
                  {isCursor ? '❯' : ' '} {item.title}
                </Text>
              );
            })}
          </Box>
        </Box>
      )}

      {mode === 'edit-pick' && (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>Select an override to edit:</Text>
          {pickerItems.map((item, idx) => {
            const isCursor = idx === editPickerNav.selectedIndex;
            return (
              <Text key={item.id} color={isCursor ? 'cyan' : undefined}>
                {isCursor ? '❯' : ' '} {item.title}
              </Text>
            );
          })}
        </Box>
      )}

      {mode === 'delete-pick' && (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>Select an override to delete:</Text>
          {pickerItems.map((item, idx) => {
            const isCursor = idx === deletePickerNav.selectedIndex;
            return (
              <Text key={item.id} color={isCursor ? 'red' : undefined}>
                {isCursor ? '❯' : ' '} {item.title}
              </Text>
            );
          })}
        </Box>
      )}

      {isFormMode && formField === 'domain' && (
        <Box marginTop={1}>
          <TextInput
            prompt="Domain to override"
            placeholder="jwks.idp.internal"
            initialValue={draftDomain}
            onSubmit={value => {
              setDraftDomain(value.trim());
              setFormField('rcfg');
            }}
            onCancel={cancelForm}
            customValidation={value =>
              (value.trim().length >= 1 && value.trim().length <= 253) || 'Domain must be 1-253 characters'
            }
          />
        </Box>
      )}

      {isFormMode && formField === 'rcfg' && (
        <Box marginTop={1}>
          <TextInput
            prompt={`VPC Lattice resource-config for "${draftDomain}"`}
            placeholder="rcfg-0123456789abcdef0"
            initialValue={mode === 'edit' && editIndex >= 0 ? overrides[editIndex]?.resourceConfigurationId : ''}
            onSubmit={submitOverride}
            onCancel={() => setFormField('domain')}
            customValidation={value =>
              RCFG_PATTERN.test(value.trim()) || 'Must be a VPC Lattice resource-config id (rcfg-...) or its ARN'
            }
          />
        </Box>
      )}
    </Box>
  );
}
