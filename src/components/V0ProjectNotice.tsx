import { createContext } from "react";
import { Box, Text } from "ink";
import { V0_PROJECT_TUI_BANNER } from "../handlers/project/v0Notice";
import { darkTheme, glyphs } from "./ui/_core";

export const V0ProjectNoticeContext = createContext(false);

export function V0ProjectBanner() {
  return (
    <Box height={1} flexShrink={0} paddingX={1}>
      <Text color={darkTheme.colors.warning} bold wrap="truncate-end">
        {glyphs.warning} {V0_PROJECT_TUI_BANNER}
      </Text>
    </Box>
  );
}
