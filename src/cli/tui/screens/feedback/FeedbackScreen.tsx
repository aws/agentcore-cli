import { CONSENT_TEXT } from '../../../operations/feedback/constants';
import {
  ErrorPrompt,
  Panel,
  PathInput,
  PromptScreen,
  ScreenLayout,
  StepIndicator,
  SuccessPrompt,
  TextInput,
} from '../../components';
import { useFeedbackFlow } from './useFeedbackFlow';
import type { FeedbackPhase } from './useFeedbackFlow';
import { Box, Text } from 'ink';
import React from 'react';

interface FeedbackScreenProps {
  initialScreenshot?: string;
  onExit: () => void;
}

type IndicatorStep = 'message' | 'screenshot' | 'consent' | 'submitting' | 'success';

const INDICATOR_STEPS: IndicatorStep[] = ['message', 'screenshot', 'consent', 'submitting', 'success'];
const INDICATOR_LABELS: Record<IndicatorStep, string> = {
  message: 'Message',
  screenshot: 'Screenshot',
  consent: 'Consent',
  submitting: 'Submitting',
  success: 'Done',
};

function indicatorStepFor(phase: FeedbackPhase): IndicatorStep {
  switch (phase) {
    case 'message':
      return 'message';
    case 'screenshot-prompt':
    case 'screenshot-path':
      return 'screenshot';
    case 'consent':
      return 'consent';
    case 'submitting':
    case 'error':
      return 'submitting';
    case 'success':
      return 'success';
  }
}

export function FeedbackScreen({ initialScreenshot, onExit }: FeedbackScreenProps) {
  const flow = useFeedbackFlow({ initialScreenshot });
  const {
    state,
    setMessage,
    chooseAttachScreenshot,
    skipScreenshot,
    setScreenshot,
    confirmConsent,
    declineConsent,
    goBack,
    retry,
  } = flow;

  const header = (
    <Box marginBottom={1}>
      <StepIndicator steps={INDICATOR_STEPS} currentStep={indicatorStepFor(state.phase)} labels={INDICATOR_LABELS} />
    </Box>
  );

  if (state.phase === 'message') {
    return (
      <ScreenLayout onExit={onExit}>
        {header}
        <Panel title="Tell us what's on your mind">
          <TextInput
            prompt="Feedback"
            placeholder="Describe what worked, what didn't, or what's missing"
            initialValue={state.message}
            onSubmit={value => setMessage(value)}
            onCancel={onExit}
            expandable
          />
          {state.inputError && <Text color="red">{state.inputError}</Text>}
          <Text dimColor>Enter to continue · Esc to exit</Text>
        </Panel>
      </ScreenLayout>
    );
  }

  if (state.phase === 'screenshot-prompt') {
    return (
      <PromptScreen
        helpText="Enter/Y attach · N skip · Esc back"
        onConfirm={chooseAttachScreenshot}
        onExit={skipScreenshot}
      >
        <Text bold>Attach a screenshot?</Text>
        <Text dimColor>PNG or JPG, max 100MB. Optional.</Text>
      </PromptScreen>
    );
  }

  if (state.phase === 'screenshot-path') {
    return (
      <ScreenLayout onExit={goBack}>
        {header}
        <Panel title="Select a screenshot (PNG/JPG, max 100MB)">
          <PathInput
            initialValue={state.screenshotPath ?? ''}
            placeholder="Path to .png or .jpg"
            onSubmit={value => void setScreenshot(value.trim() || undefined)}
            onCancel={goBack}
          />
          {state.inputError && <Text color="red">{state.inputError}</Text>}
          <Text dimColor>↑↓ navigate · → open dir · Enter select file · Esc to go back</Text>
        </Panel>
      </ScreenLayout>
    );
  }

  if (state.phase === 'consent') {
    return (
      <PromptScreen
        helpText="Enter/Y submit · Esc/N cancel"
        onConfirm={confirmConsent}
        onExit={declineConsent}
        borderColor="yellow"
      >
        <Text bold>AWS Customer Agreement</Text>
        <Text>{CONSENT_TEXT}</Text>
        {state.screenshotPath && <Text dimColor>Screenshot: {state.screenshotPath}</Text>}
      </PromptScreen>
    );
  }

  if (state.phase === 'submitting') {
    return (
      <ScreenLayout>
        {header}
        <Panel>
          <Text>Submitting feedback…</Text>
        </Panel>
      </ScreenLayout>
    );
  }

  if (state.phase === 'success') {
    return (
      <SuccessPrompt
        message="Thank you. Your feedback has been submitted."
        detail={state.result ? `Submission id: ${state.result.id}` : undefined}
        onExit={onExit}
      />
    );
  }

  return <ErrorPrompt message="Failed to submit feedback." detail={state.error} onBack={retry} onExit={onExit} />;
}
