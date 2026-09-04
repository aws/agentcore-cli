import React, { useState } from "react";
import { Text, Box, useInput, useApp } from "ink";
import { darkTheme, glyphs } from "../_core.js";
import type { InkUITheme } from "../_core.js";

export interface ConfirmProps {
  message: string;
  /** Default answer — true = Y default, false = N default */
  defaultValue?: boolean;
  onConfirm: () => void;
  onCancel?: () => void;
  theme?: InkUITheme;
}

export const Confirm: React.FC<ConfirmProps> = ({
  message,
  defaultValue = false,
  onConfirm,
  onCancel,
  theme = darkTheme,
}) => {
  const { exit } = useApp();
  const [answered, setAnswered] = useState<boolean | null>(null);

  const hint = defaultValue ? "(Y/n)" : "(y/N)";

  useInput((input, key) => {
    if (answered !== null) return;

    if (input === "y" || input === "Y") {
      setAnswered(true);
      onConfirm();
    } else if (input === "n" || input === "N" || key.escape) {
      setAnswered(false);
      onCancel?.();
    } else if (key.return) {
      const choice = defaultValue;
      setAnswered(choice);
      if (choice) onConfirm();
      else onCancel?.();
    } else if (key.ctrl && input === "c") {
      exit();
    }
  });

  if (answered !== null) {
    return (
      <Box>
        <Text color={answered ? theme.colors.success : theme.colors.error}>
          {answered ? `${glyphs.check} Confirmed` : `${glyphs.cross} Cancelled`}
        </Text>
      </Box>
    );
  }

  return (
    <Box gap={1}>
      <Text color={theme.colors.primary}>?</Text>
      <Text>{message}</Text>
      <Text dimColor>{hint}</Text>
      <Text color={theme.colors.primary}>█</Text>
    </Box>
  );
};
