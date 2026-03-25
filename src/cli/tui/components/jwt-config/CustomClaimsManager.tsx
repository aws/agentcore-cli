import { useListNavigation } from '../../hooks';
import type { SelectableItem } from '../index';
import { CustomClaimForm } from './CustomClaimForm';
import type { ClaimsManagerMode, CustomClaimEntry } from './types';
import { formatClaimSummary } from './types';
import { Box, Text } from 'ink';
import React, { useCallback, useMemo, useState } from 'react';

export interface CustomClaimsManagerProps {
  initialClaims: CustomClaimEntry[];
  onDone: (claims: CustomClaimEntry[]) => void;
  onCancel: () => void;
  onModeChange?: (mode: ClaimsManagerMode) => void;
}

export function CustomClaimsManager({ initialClaims, onDone, onCancel, onModeChange }: CustomClaimsManagerProps) {
  const [claims, setClaims] = useState<CustomClaimEntry[]>(initialClaims);
  const [mode, setMode] = useState<ClaimsManagerMode>(initialClaims.length > 0 ? 'list' : 'add');
  const [editIndex, setEditIndex] = useState(-1);

  React.useEffect(() => {
    onModeChange?.(mode);
  }, [mode, onModeChange]);

  // Action items for the list view
  const actionItems = useMemo<SelectableItem[]>(() => {
    const items: SelectableItem[] = [{ id: 'add', title: 'Add claim' }];
    if (claims.length > 0) {
      items.push({ id: 'edit', title: 'Edit existing claim' });
      items.push({ id: 'delete', title: 'Delete claim' });
      items.push({ id: 'done', title: 'Done' });
    }
    return items;
  }, [claims.length]);

  const actionNav = useListNavigation({
    items: actionItems,
    onSelect: item => {
      if (item.id === 'add') setMode('add');
      else if (item.id === 'edit') setMode('edit-pick');
      else if (item.id === 'delete') setMode('delete-pick');
      else if (item.id === 'done') onDone(claims);
    },
    onExit: onCancel,
    isActive: mode === 'list',
  });

  // Claim picker for edit mode
  const claimPickerItems = useMemo<SelectableItem[]>(
    () => claims.map((c, i) => ({ id: String(i), title: formatClaimSummary(c) })),
    [claims]
  );

  const claimPickerNav = useListNavigation({
    items: claimPickerItems,
    onSelect: (_, index) => {
      setEditIndex(index);
      setMode('edit');
    },
    onExit: () => setMode('list'),
    isActive: mode === 'edit-pick',
  });

  const deletePickerNav = useListNavigation({
    items: claimPickerItems,
    onSelect: (_, index) => {
      setClaims(prev => {
        const next = prev.filter((_, i) => i !== index);
        setMode(next.length === 0 ? 'add' : 'list');
        return next;
      });
    },
    onExit: () => setMode('list'),
    isActive: mode === 'delete-pick',
  });

  const handleClaimSave = useCallback(
    (claim: CustomClaimEntry) => {
      if (mode === 'edit' && editIndex >= 0) {
        setClaims(prev => prev.map((c, i) => (i === editIndex ? claim : c)));
      } else {
        setClaims(prev => [...prev, claim]);
      }
      setMode('list');
      setEditIndex(-1);
    },
    [mode, editIndex]
  );

  const handleClaimCancel = useCallback(() => {
    if (claims.length > 0) {
      setMode('list');
    } else {
      onCancel();
    }
  }, [claims.length, onCancel]);

  return (
    <Box flexDirection="column">
      <Text bold>Custom Claims</Text>

      {mode === 'list' && (
        <Box flexDirection="column">
          {claims.length > 0 && (
            <Box marginTop={1} flexDirection="column">
              {claims.map((claim, i) => (
                <Text key={i} dimColor>
                  {i + 1}. {formatClaimSummary(claim)}
                </Text>
              ))}
            </Box>
          )}
          <Box marginTop={1} flexDirection="column">
            {actionItems.map((item, idx) => {
              const isCursor = idx === actionNav.selectedIndex;
              return (
                <Text key={item.id}>
                  <Text color={isCursor ? 'cyan' : undefined}>
                    {isCursor ? '❯' : ' '} {item.title}
                  </Text>
                </Text>
              );
            })}
          </Box>
        </Box>
      )}

      {mode === 'edit-pick' && (
        <Box flexDirection="column">
          <Text dimColor>Select a claim to edit:</Text>
          <Box marginTop={1} flexDirection="column">
            {claimPickerItems.map((item, idx) => {
              const isCursor = idx === claimPickerNav.selectedIndex;
              return (
                <Text key={item.id}>
                  <Text color={isCursor ? 'cyan' : undefined}>
                    {isCursor ? '❯' : ' '} {item.title}
                  </Text>
                </Text>
              );
            })}
          </Box>
        </Box>
      )}

      {mode === 'delete-pick' && (
        <Box flexDirection="column">
          <Text dimColor>Select a claim to delete:</Text>
          <Box marginTop={1} flexDirection="column">
            {claimPickerItems.map((item, idx) => {
              const isCursor = idx === deletePickerNav.selectedIndex;
              return (
                <Text key={item.id}>
                  <Text color={isCursor ? 'red' : undefined}>
                    {isCursor ? '❯' : ' '} {item.title}
                  </Text>
                </Text>
              );
            })}
          </Box>
        </Box>
      )}

      {(mode === 'add' || mode === 'edit') && (
        <CustomClaimForm
          initialClaim={mode === 'edit' && editIndex >= 0 ? claims[editIndex] : undefined}
          onSave={handleClaimSave}
          onCancel={handleClaimCancel}
        />
      )}
    </Box>
  );
}
