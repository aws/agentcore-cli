import { STATUS_COLORS, TEXT_COLORS } from '../theme';
import { Box, Text } from 'ink';
import React, { useEffect, useState } from 'react';

export type StepStatus = 'pending' | 'running' | 'success' | 'error' | 'warn' | 'info';

export interface Step {
  label: string;
  status: StepStatus;
  error?: string;
  warn?: string;
  info?: string;
}

// eslint-disable-next-line react-refresh/only-export-components
export function hasStepError(steps: Step[]): boolean {
  return steps.some(s => s.status === 'error');
}

// eslint-disable-next-line react-refresh/only-export-components
export function areStepsComplete(steps: Step[]): boolean {
  if (steps.length === 0) return false;
  return steps.every(s => s.status === 'success' || s.status === 'error' || s.status === 'warn' || s.status === 'info');
}

const STEP_LABELS = {
  pending: '          ',
  running: '          ',
  success: '[done]    ',
  error: '[error]   ',
  warn: '[warning] ',
  info: '          ',
} as const;

const STEP_COLORS = {
  pending: TEXT_COLORS.muted,
  running: undefined,
  success: STATUS_COLORS.success,
  error: STATUS_COLORS.error,
  warn: STATUS_COLORS.warning,
  info: undefined,
} as const;

interface GradientTextProps {
  text: string;
}

type CharBrightness = 'white' | 'gray' | 'dim';

function getCharBrightness(distance: number): CharBrightness {
  if (distance <= 2) return 'white';
  if (distance <= 4) return 'gray';
  return 'dim';
}

export function GradientText({ text }: GradientTextProps) {
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setOffset(prev => (prev + 1) % text.length);
    }, 125);
    return () => clearInterval(interval);
  }, [text.length]);

  const chars = text.split('');
  return (
    <Text>
      {chars.map((char, i) => {
        const distance = Math.abs(i - offset);
        const brightness = getCharBrightness(distance);

        if (brightness === 'dim') {
          return (
            <Text key={i} dimColor>
              {char}
            </Text>
          );
        }

        return (
          <Text key={i} color={brightness === 'white' ? TEXT_COLORS.primary : TEXT_COLORS.muted}>
            {char}
          </Text>
        );
      })}
    </Text>
  );
}

interface StepIndicatorProps {
  step: Step;
}

function StepIndicator({ step }: StepIndicatorProps) {
  const label = STEP_LABELS[step.status];
  const color = STEP_COLORS[step.status];

  if (step.status === 'running') {
    return (
      <Box>
        <Text>{label}</Text>
        <GradientText text={step.label} />
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text color={color} dimColor={step.status === 'pending'}>
        {label}
        {step.label}
      </Text>
      {step.status === 'error' && step.error && (
        <Text color={STATUS_COLORS.error}>
          {'          → '}
          {step.error}
        </Text>
      )}
      {step.status === 'warn' && step.warn && (
        <Text color={STATUS_COLORS.warning}>
          {'          → '}
          {step.warn}
        </Text>
      )}
      {step.status === 'info' && step.info && (
        <Text color={STATUS_COLORS.info}>
          {'          → '}
          {step.info}
        </Text>
      )}
    </Box>
  );
}

interface StepProgressProps {
  steps: Step[];
}

export function StepProgress({ steps }: StepProgressProps) {
  // Find if there's an error - if so, don't show pending steps after it
  const errorIndex = steps.findIndex(s => s.status === 'error');
  const visibleSteps = errorIndex >= 0 ? steps.slice(0, errorIndex + 1) : steps;

  return (
    <Box flexDirection="column">
      {visibleSteps.map((step, i) => (
        <StepIndicator key={i} step={step} />
      ))}
    </Box>
  );
}
