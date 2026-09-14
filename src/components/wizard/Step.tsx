import { isValidElement, type ReactElement, type ReactNode } from "react";
import { Box, Text } from "ink";
import { darkTheme } from "../ui/_core.js";

const theme = darkTheme;

export interface StepProps {
  // React reserves `key`, so this cannot use that prop name.
  stepKey: string;
  title?: string;
  prompt?: string;
  children: ReactNode;
}

// One field per step. Every field registers its own useInput and answers enter,
// esc and the arrows itself; two fields mounted at once would both react to the
// same keystroke. A step needing related inputs should use one compound field.
export function Step({ prompt, children }: StepProps) {
  return (
    <Box flexDirection="column" paddingX={1}>
      {prompt !== undefined && <Text color={theme.colors.muted}>{prompt}</Text>}
      {children}
    </Box>
  );
}

export function isStepElement(child: ReactNode): child is ReactElement<StepProps> {
  return isValidElement(child) && child.type === Step;
}
