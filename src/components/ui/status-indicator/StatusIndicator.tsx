import React, { useState, useEffect } from "react";
import { Text, Box } from "ink";
import { darkTheme, glyphs } from "../_core.js";
import type { InkUITheme } from "../_core.js";

export type StatusValue = "online" | "offline" | "loading" | "warning" | "error" | "idle";

export interface StatusIndicatorProps {
  status: StatusValue;
  label: string;
  /** Animate the dot — auto-enabled for loading status */
  pulse?: boolean;
  theme?: InkUITheme;
}

const PULSE_FRAMES = ["●", "◉", "●", "○"];

function statusColor(status: StatusValue, theme: InkUITheme): string {
  switch (status) {
    case "online":
      return theme.colors.success;
    case "offline":
      return theme.colors.error;
    case "error":
      return theme.colors.error;
    case "warning":
      return theme.colors.warning;
    case "loading":
      return theme.colors.warning;
    case "idle":
      return theme.colors.muted;
  }
}

function staticDot(status: StatusValue): string {
  switch (status) {
    case "online":
      return "●";
    case "offline":
      return "○";
    case "error":
      return "●";
    case "warning":
      return glyphs.warning;
    case "loading":
      return "◉";
    case "idle":
      return "○";
  }
}

export const StatusIndicator: React.FC<StatusIndicatorProps> = ({
  status,
  label,
  pulse,
  theme = darkTheme,
}) => {
  const shouldAnimate = pulse ?? status === "loading";
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!shouldAnimate) return;
    const t = setInterval(() => setFrame((f) => (f + 1) % PULSE_FRAMES.length), 400);
    return () => clearInterval(t);
  }, [shouldAnimate]);

  const dot = shouldAnimate ? PULSE_FRAMES[frame] : staticDot(status);
  const color = statusColor(status, theme);

  return (
    <Box gap={1}>
      <Text color={color}>{dot}</Text>
      <Text>{label}</Text>
    </Box>
  );
};
