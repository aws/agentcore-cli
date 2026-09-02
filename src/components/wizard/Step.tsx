import React from "react";
import { Box, Text } from "ink";
import { darkTheme } from "../ui/_core.js";

const theme = darkTheme;

export interface StepProps {
  // name is the step's stable key. Position is tracked by key rather than by
  // index because branches have different lengths: a conditional step that
  // appears or disappears must not shift the user to a different question.
  name: string;
  // title labels the step in the Stepper; defaults to `name`.
  title?: string;
  // question is the one-line prompt shown under the Stepper. The Stepper
  // already names the step, so the body opens with the question itself.
  question?: string;
  children: React.ReactNode;
}

// Step is one page of a <Wizard>: the stepper entry, the question line, and the
// field that collects the answer.
//
// One field per step. Every field registers its own useInput and answers enter,
// esc and the arrows itself; two fields mounted at once would both react to the
// same keystroke. The shell has no notion of focus and is not meant to grow
// one — a step that genuinely needs two related inputs should get a single
// compound field that owns one useInput and manages focus internally.
export function Step({ question, children }: StepProps) {
  return (
    <Box flexDirection="column" paddingX={1}>
      {question !== undefined && <Text color={theme.colors.muted}>{question}</Text>}
      {children}
    </Box>
  );
}

// isStepElement narrows a child to a <Step>. React.Children.toArray already
// drops the `false`/`null` that a `{condition && <Step/>}` branch produces, so
// filtering with this yields exactly the steps that apply to the current
// answers — which is how a wizard branches without a step-list useMemo.
export function isStepElement(child: React.ReactNode): child is React.ReactElement<StepProps> {
  return React.isValidElement(child) && child.type === Step;
}
