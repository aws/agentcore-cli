import { Box, Text } from "ink";
import { useTuiUpdate } from "./TuiUpdateContext";
import { Badge } from "./ui/badge/Badge";
import { Divider } from "./ui/divider";
import { darkTheme, type InkUITheme } from "./ui/_core";

const LOGO: string[] = [
  "█▀█ █▀▀ █▀▀ █▀█ ▀█▀ █▀▀ █▀█ █▀▄ █▀▀",
  "█▀█ █ █ █▀▀ █ █  █  █   █ █ █▀▄ █▀▀",
  "▀ ▀ ▀▀▀ ▀▀▀ ▀ ▀  ▀  ▀▀▀ ▀▀▀ ▀ ▀ ▀▀▀",
];

export const MIN_BANNER_COLUMNS = 80;
export const MIN_BANNER_ROWS = 30;
export const BRAND_BANNER_ROWS = LOGO.length + 1;

export interface BrandBannerProps {
  terminalProgram?: string;
  theme?: InkUITheme;
}

export function shouldHideBrandBanner(terminalProgram: string | undefined): boolean {
  return terminalProgram === "Apple_Terminal";
}

export function BrandBanner({
  terminalProgram = process.env.TERM_PROGRAM,
  theme = darkTheme,
}: BrandBannerProps = {}) {
  const updateState = useTuiUpdate();
  if (shouldHideBrandBanner(terminalProgram)) return null;

  const color = theme.colors.text;
  const versionLabel = `v${updateState.currentVersion}${
    updateState.updateAvailable ? " • update available" : ""
  }`;

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box paddingX={1} alignItems="flex-start">
        <Box flexDirection="column">
          {LOGO.map((line, index) => (
            <Text key={index} color={color}>
              {line}
            </Text>
          ))}
        </Box>
        <Box marginLeft={1}>
          <Badge
            theme={theme}
            color={updateState.updateAvailable ? theme.colors.warning : theme.colors.secondary}
          >
            <>CLI {versionLabel}</>
          </Badge>
        </Box>
      </Box>
      <Divider />
    </Box>
  );
}
