import { Cursor } from '../index';
import type { ClaimOperator, ClaimValueType, CustomClaimEntry } from './types';
import { Box, Text, useInput } from 'ink';
import React, { useState } from 'react';

const VALUE_TYPES: ClaimValueType[] = ['STRING', 'STRING_ARRAY'];
const OPERATORS: ClaimOperator[] = ['EQUALS', 'CONTAINS', 'CONTAINS_ANY'];

type ClaimField = 'claimName' | 'valueType' | 'operator' | 'matchValue';
const CLAIM_FIELDS: ClaimField[] = ['claimName', 'valueType', 'operator', 'matchValue'];

export interface CustomClaimFormProps {
  initialClaim?: CustomClaimEntry;
  onSave: (claim: CustomClaimEntry) => void;
  onCancel: () => void;
}

export function CustomClaimForm({ initialClaim, onSave, onCancel }: CustomClaimFormProps) {
  const [activeField, setActiveField] = useState<ClaimField>('claimName');
  const [claimName, setClaimName] = useState(initialClaim?.claimName ?? '');
  const [valueType, setValueType] = useState<ClaimValueType>(initialClaim?.valueType ?? 'STRING');
  const [operator, setOperator] = useState<ClaimOperator>(initialClaim?.operator ?? 'EQUALS');
  const [matchValue, setMatchValue] = useState(initialClaim?.matchValue ?? '');
  const [error, setError] = useState<string | null>(null);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }

    // Tab / Shift+Tab / Up / Down to cycle fields
    if (key.tab || key.upArrow || key.downArrow) {
      const idx = CLAIM_FIELDS.indexOf(activeField);
      if (key.shift || key.upArrow) {
        setActiveField(CLAIM_FIELDS[(idx - 1 + CLAIM_FIELDS.length) % CLAIM_FIELDS.length]!);
      } else {
        setActiveField(CLAIM_FIELDS[(idx + 1) % CLAIM_FIELDS.length]!);
      }
      setError(null);
      return;
    }

    // Enter: advance to next field, or submit on the last field
    if (key.return) {
      const idx = CLAIM_FIELDS.indexOf(activeField);
      if (idx < CLAIM_FIELDS.length - 1) {
        // Validate current field before advancing
        if (activeField === 'claimName') {
          if (!claimName.trim()) {
            setError('Claim name is required');
            return;
          }
          if (!/^[A-Za-z0-9_.\-:]+$/.test(claimName.trim())) {
            setError('Claim name may only contain letters, digits, _, ., -, :');
            return;
          }
        }
        setActiveField(CLAIM_FIELDS[idx + 1]!);
        setError(null);
        return;
      }
      // Last field — submit
      if (!claimName.trim()) {
        setError('Claim name is required');
        return;
      }
      if (!/^[A-Za-z0-9_.\-:]+$/.test(claimName.trim())) {
        setError('Claim name may only contain letters, digits, _, ., -, :');
        return;
      }
      if (!matchValue.trim()) {
        setError('Match value is required');
        return;
      }
      if (valueType === 'STRING_ARRAY') {
        const values = matchValue
          .split(',')
          .map(v => v.trim())
          .filter(Boolean);
        if (values.length === 0) {
          setError('At least one non-empty value is required');
          return;
        }
      }
      onSave({ claimName: claimName.trim(), valueType, operator, matchValue: matchValue.trim() });
      return;
    }

    // For text fields: handle typing
    if (activeField === 'claimName' || activeField === 'matchValue') {
      if (key.backspace || key.delete) {
        if (activeField === 'claimName') setClaimName(v => v.slice(0, -1));
        else setMatchValue(v => v.slice(0, -1));
        setError(null);
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        if (activeField === 'claimName') setClaimName(v => v + input);
        else setMatchValue(v => v + input);
        setError(null);
        return;
      }
    }

    // For select fields: left/right to cycle
    if (activeField === 'valueType') {
      if (key.leftArrow || key.rightArrow) {
        const idx = VALUE_TYPES.indexOf(valueType);
        const next = key.rightArrow
          ? (idx + 1) % VALUE_TYPES.length
          : (idx - 1 + VALUE_TYPES.length) % VALUE_TYPES.length;
        setValueType(VALUE_TYPES[next]!);
        return;
      }
    }

    if (activeField === 'operator') {
      if (key.leftArrow || key.rightArrow) {
        const idx = OPERATORS.indexOf(operator);
        const next = key.rightArrow ? (idx + 1) % OPERATORS.length : (idx - 1 + OPERATORS.length) % OPERATORS.length;
        setOperator(OPERATORS[next]!);
        return;
      }
    }
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>{initialClaim ? 'Edit Claim' : 'New Claim'}</Text>

      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text color={activeField === 'claimName' ? 'cyan' : 'gray'}>Claim name: </Text>
          {activeField === 'claimName' && !claimName && <Cursor />}
          <Text color={activeField === 'claimName' ? undefined : 'gray'}>
            {claimName || <Text dimColor>e.g., department</Text>}
          </Text>
          {activeField === 'claimName' && claimName && <Cursor />}
        </Box>

        <Box>
          <Text color={activeField === 'valueType' ? 'cyan' : 'gray'}>Value type: </Text>
          <Text color={activeField === 'valueType' ? 'yellow' : 'gray'}>
            {valueType === 'STRING' ? 'String' : 'String Array'}
          </Text>
          {activeField === 'valueType' && (
            <Text dimColor>
              {' '}
              ◂ {VALUE_TYPES.indexOf(valueType) + 1}/{VALUE_TYPES.length} ▸
            </Text>
          )}
        </Box>

        <Box>
          <Text color={activeField === 'operator' ? 'cyan' : 'gray'}>Operator: </Text>
          <Text color={activeField === 'operator' ? 'yellow' : 'gray'}>
            {operator === 'EQUALS' ? 'Equals' : operator === 'CONTAINS' ? 'Contains' : 'Contains Any'}
          </Text>
          {activeField === 'operator' && (
            <Text dimColor>
              {' '}
              ◂ {OPERATORS.indexOf(operator) + 1}/{OPERATORS.length} ▸
            </Text>
          )}
        </Box>

        <Box>
          <Text color={activeField === 'matchValue' ? 'cyan' : 'gray'}>Match value: </Text>
          {activeField === 'matchValue' && !matchValue && <Cursor />}
          <Text color={activeField === 'matchValue' ? undefined : 'gray'}>
            {matchValue || (
              <Text dimColor>
                {valueType === 'STRING_ARRAY' ? 'comma-separated, e.g., admin, dev' : 'e.g., engineering'}
              </Text>
            )}
          </Text>
          {activeField === 'matchValue' && matchValue && <Cursor />}
        </Box>
      </Box>

      {error && (
        <Box marginTop={1}>
          <Text color="red">{error}</Text>
        </Box>
      )}
    </Box>
  );
}
