import type { FilterRule, FilterValue } from '../../../../schema';
import type { SelectableItem } from '../../components';
import { ConfirmReview, Panel, TextInput, WizardSelect } from '../../components';
import { useListNavigation } from '../../hooks';
import { FILTER_OPERATOR_OPTIONS, type FilterValueType } from './types';
import { Box, Text } from 'ink';
import React, { useCallback, useMemo, useState } from 'react';

type SubStep =
  | 'start'
  | 'enter-key'
  | 'pick-operator'
  | 'pick-value-type'
  | 'enter-value'
  | 'pick-bool-value'
  | 'review';

interface FilterBuilderProps {
  initial?: FilterRule[];
  onComplete: (filters: FilterRule[]) => void;
  onCancel: () => void;
}

/**
 * Inline filter sub-wizard. Lets the user build zero or more {@link FilterRule}s,
 * one at a time, and confirm.
 */
export function FilterBuilder({ initial, onComplete, onCancel }: FilterBuilderProps) {
  const [filters, setFilters] = useState<FilterRule[]>(initial ?? []);
  const [sub, setSub] = useState<SubStep>('start');
  const [draftKey, setDraftKey] = useState('');
  const [draftOp, setDraftOp] = useState<(typeof FILTER_OPERATOR_OPTIONS)[number]>('Equals');
  const [draftType, setDraftType] = useState<FilterValueType>('string');

  const finishDraft = useCallback(
    (value: FilterValue) => {
      setFilters(prev => [...prev, { key: draftKey, operator: draftOp, value }]);
      setDraftKey('');
      setDraftOp('Equals');
      setDraftType('string');
      setSub('start');
    },
    [draftKey, draftOp]
  );

  const startItems: SelectableItem[] = useMemo(
    () => [
      { id: 'add', title: filters.length === 0 ? 'Add a filter' : 'Add another filter' },
      { id: 'done', title: filters.length === 0 ? 'No filters (skip)' : 'Done' },
      ...(filters.length > 0
        ? [{ id: 'clear', title: 'Remove last filter', description: filters[filters.length - 1]!.key }]
        : []),
    ],
    [filters]
  );

  const startNav = useListNavigation({
    items: startItems,
    onSelect: item => {
      if (item.id === 'add') setSub('enter-key');
      else if (item.id === 'done') onComplete(filters);
      else if (item.id === 'clear') setFilters(prev => prev.slice(0, -1));
    },
    onExit: () => onCancel(),
    isActive: sub === 'start',
  });

  const operatorItems: SelectableItem[] = useMemo(() => FILTER_OPERATOR_OPTIONS.map(op => ({ id: op, title: op })), []);
  const operatorNav = useListNavigation({
    items: operatorItems,
    onSelect: item => {
      setDraftOp(item.id as (typeof FILTER_OPERATOR_OPTIONS)[number]);
      setSub('pick-value-type');
    },
    onExit: () => setSub('enter-key'),
    isActive: sub === 'pick-operator',
  });

  const typeItems: SelectableItem[] = useMemo(
    () => [
      { id: 'string', title: 'string' },
      { id: 'double', title: 'double (number)' },
      { id: 'boolean', title: 'boolean' },
    ],
    []
  );
  const typeNav = useListNavigation({
    items: typeItems,
    onSelect: item => {
      setDraftType(item.id as FilterValueType);
      setSub(item.id === 'boolean' ? 'pick-bool-value' : 'enter-value');
    },
    onExit: () => setSub('pick-operator'),
    isActive: sub === 'pick-value-type',
  });

  const boolItems: SelectableItem[] = useMemo(
    () => [
      { id: 'true', title: 'true' },
      { id: 'false', title: 'false' },
    ],
    []
  );
  const boolNav = useListNavigation({
    items: boolItems,
    onSelect: item => finishDraft({ booleanValue: item.id === 'true' }),
    onExit: () => setSub('pick-value-type'),
    isActive: sub === 'pick-bool-value',
  });

  return (
    <Panel>
      {sub === 'start' && (
        <Box flexDirection="column">
          <Text dimColor>
            Optional: filter rules. Only traces matching every filter are evaluated. Leave empty to evaluate all sampled
            traces.
          </Text>
          {filters.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text>Current filters:</Text>
              {filters.map((f, i) => (
                <Text key={i} dimColor>
                  {`  [${i + 1}] ${f.key} ${f.operator} ${JSON.stringify(f.value)}`}
                </Text>
              ))}
            </Box>
          )}
          <Box marginTop={1}>
            <WizardSelect title="Filters" items={startItems} selectedIndex={startNav.selectedIndex} />
          </Box>
        </Box>
      )}

      {sub === 'enter-key' && (
        <TextInput
          key="filter-key"
          prompt="Filter key (e.g. userId, score, isPremium)"
          initialValue={draftKey}
          onSubmit={v => {
            setDraftKey(v);
            setSub('pick-operator');
          }}
          onCancel={() => setSub('start')}
          customValidation={v => (v.trim().length > 0 ? true : 'Key cannot be empty')}
        />
      )}

      {sub === 'pick-operator' && (
        <WizardSelect title="Operator" items={operatorItems} selectedIndex={operatorNav.selectedIndex} />
      )}

      {sub === 'pick-value-type' && (
        <WizardSelect title="Value type" items={typeItems} selectedIndex={typeNav.selectedIndex} />
      )}

      {sub === 'enter-value' && draftType !== 'boolean' && (
        <TextInput
          key="filter-value"
          prompt={draftType === 'double' ? 'Value (number)' : 'Value (string)'}
          initialValue=""
          onSubmit={v => {
            if (draftType === 'double') {
              const n = Number(v);
              if (!Number.isFinite(n)) return;
              finishDraft({ doubleValue: n });
            } else {
              finishDraft({ stringValue: v });
            }
          }}
          onCancel={() => setSub('pick-value-type')}
          customValidation={v => {
            if (draftType === 'double') {
              return Number.isFinite(Number(v)) || 'Must be a number';
            }
            return v.length > 0 || 'Value cannot be empty';
          }}
        />
      )}

      {sub === 'pick-bool-value' && (
        <WizardSelect title="Boolean value" items={boolItems} selectedIndex={boolNav.selectedIndex} />
      )}

      {sub === 'review' && (
        <ConfirmReview
          fields={filters.map((f, i) => ({
            label: `Filter ${i + 1}`,
            value: `${f.key} ${f.operator} ${JSON.stringify(f.value)}`,
          }))}
        />
      )}
    </Panel>
  );
}
