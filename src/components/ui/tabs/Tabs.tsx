import React from "react";
import { Box, Text, useInput } from "ink";
import { darkTheme } from "../_core.js";
import type { InkUITheme } from "../_core.js";

export interface Tab {
  key: string;
  label: string;
  badge?: number;
  disabled?: boolean;
}

export interface TabsProps {
  tabs: Tab[];
  activeKey?: string;
  onChange: (key: string) => void;
  position?: "top" | "bottom";
  variant?: "underline" | "boxed" | "pills";
  focus?: boolean;
  theme?: InkUITheme;
  children: React.ReactNode;
}

export const Tabs: React.FC<TabsProps> = ({
  tabs,
  activeKey,
  onChange,
  position = "top",
  variant = "underline",
  focus = true,
  theme = darkTheme,
  children,
}) => {
  const enabledTabs = tabs.filter((t) => !t.disabled);
  const activeIndex = tabs.findIndex((t) => t.key === activeKey);
  const effectiveActiveKey = activeKey ?? enabledTabs[0]?.key ?? "";

  useInput(
    (input, key) => {
      const currentIndex = tabs.findIndex((t) => t.key === effectiveActiveKey);
      if (key.leftArrow || input === "h") {
        for (let i = currentIndex - 1; i >= 0; i--) {
          if (!tabs[i].disabled) {
            onChange(tabs[i].key);
            break;
          }
        }
      } else if (key.rightArrow || input === "l") {
        for (let i = currentIndex + 1; i < tabs.length; i++) {
          if (!tabs[i].disabled) {
            onChange(tabs[i].key);
            break;
          }
        }
      } else if (input >= "1" && input <= "9") {
        const idx = parseInt(input, 10) - 1;
        if (idx < tabs.length && !tabs[idx].disabled) onChange(tabs[idx].key);
      }
    },
    { isActive: focus },
  );

  const childArray = React.Children.toArray(children);
  const activeChildIndex = Math.max(0, activeIndex);
  const activeChild = childArray[activeChildIndex] ?? null;

  const renderTabBar = () => (
    <Box flexDirection="row" gap={2}>
      {tabs.map((tab) => {
        const isActive = tab.key === effectiveActiveKey;
        const isDisabled = tab.disabled;

        let label = tab.label;
        if (tab.badge !== undefined) label += ` (${tab.badge})`;

        if (variant === "underline") {
          return (
            <Box key={tab.key} flexDirection="column">
              <Text
                bold={isActive}
                color={
                  isDisabled
                    ? theme.colors.muted
                    : isActive
                      ? theme.colors.primary
                      : theme.colors.muted
                }
                dimColor={isDisabled}
              >
                {label}
              </Text>
              {isActive && <Text color={theme.colors.primary}>{"─".repeat(label.length)}</Text>}
            </Box>
          );
        }

        if (variant === "boxed") {
          return (
            <Box
              key={tab.key}
              borderStyle={isActive ? "single" : undefined}
              paddingX={isActive ? 1 : 0}
            >
              <Text
                bold={isActive}
                color={
                  isDisabled
                    ? theme.colors.muted
                    : isActive
                      ? theme.colors.primary
                      : theme.colors.muted
                }
                dimColor={isDisabled}
              >
                {label}
              </Text>
            </Box>
          );
        }

        // pills
        return (
          <Text
            key={tab.key}
            bold={isActive}
            color={
              isDisabled ? theme.colors.muted : isActive ? theme.colors.primary : theme.colors.muted
            }
            dimColor={isDisabled}
          >
            {isActive ? `[${label}]` : ` ${label} `}
          </Text>
        );
      })}
    </Box>
  );

  return (
    <Box flexDirection="column">
      {position === "top" && renderTabBar()}
      <Box marginTop={position === "top" ? 1 : 0} marginBottom={position === "bottom" ? 1 : 0}>
        {activeChild}
      </Box>
      {position === "bottom" && renderTabBar()}
    </Box>
  );
};
