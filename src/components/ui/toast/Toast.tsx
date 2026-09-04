import React, { useState, useEffect, useCallback } from "react";
import { Text, Box } from "ink";
import { darkTheme, glyphs } from "../_core.js";
import type { InkUITheme } from "../_core.js";

export type ToastVariant = "success" | "warning" | "error" | "info";

export interface ToastProps {
  message: string;
  variant?: ToastVariant;
  /** ms before auto-dismiss. 0 = permanent. Default 3000 */
  duration?: number;
  onDismiss?: () => void;
  theme?: InkUITheme;
}

const ICONS: Record<ToastVariant, string> = {
  success: glyphs.check,
  warning: glyphs.warning,
  error: glyphs.cross,
  info: glyphs.info,
};

function variantColor(variant: ToastVariant, theme: InkUITheme): string {
  switch (variant) {
    case "success":
      return theme.colors.success;
    case "warning":
      return theme.colors.warning;
    case "error":
      return theme.colors.error;
    case "info":
      return theme.colors.primary;
  }
}

export const Toast: React.FC<ToastProps> = ({
  message,
  variant = "info",
  duration = 3000,
  onDismiss,
  theme = darkTheme,
}) => {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (duration === 0) return;
    const timer = setTimeout(() => {
      setVisible(false);
      onDismiss?.();
    }, duration);
    return () => clearTimeout(timer);
  }, [duration, onDismiss]);

  if (!visible) return null;

  const color = variantColor(variant, theme);

  return (
    <Box>
      <Text color={color}>{ICONS[variant]} </Text>
      <Text>{message}</Text>
    </Box>
  );
};

/* ── useToast hook ─────────────────────────────────────────── */

export interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
  duration: number;
}

let _nextId = 0;

export function useToast() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const show = useCallback((message: string, variant: ToastVariant = "info", duration = 3000) => {
    const id = ++_nextId;
    setToasts((prev) => [...prev, { id, message, variant, duration }]);
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return { toasts, show, dismiss };
}

/* ── ToastStack ────────────────────────────────────────────── */

export interface ToastStackProps {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
  theme?: InkUITheme;
}

export const ToastStack: React.FC<ToastStackProps> = ({ toasts, onDismiss, theme = darkTheme }) => (
  <Box flexDirection="column">
    {toasts.map((t) => (
      <Toast
        key={t.id}
        message={t.message}
        variant={t.variant}
        duration={t.duration}
        onDismiss={() => onDismiss(t.id)}
        theme={theme}
      />
    ))}
  </Box>
);
