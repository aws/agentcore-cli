import { Box } from "ink";
import { PACKAGE_VERSION } from "../constants";
import { Badge } from "./ui/badge";
import { Divider } from "./ui/divider";
import { GradientText } from "./ui/gradient-text";

const LOGO: string[] = [
  "█▀█ █▀▀ █▀▀ █▀█ ▀█▀ █▀▀ █▀█ █▀▄ █▀▀   █▀▀ █   ▀█▀",
  "█▀█ █ █ █▀▀ █ █  █  █   █ █ █▀▄ █▀▀   █   █    █ ",
  "▀ ▀ ▀▀▀ ▀▀▀ ▀ ▀  ▀  ▀▀▀ ▀▀▀ ▀ ▀ ▀▀▀   ▀▀▀ ▀▀▀ ▀▀▀",
];

const LOGO_GRADIENT = ["#00ffff", "#ff00ff"] as const;

export function BrandBanner() {
  if (LOGO.length === 0) return null;

  const logoWidth = Math.max(...LOGO.map((line) => Array.from(line).length));

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box paddingX={1} alignItems="flex-start">
        <Box flexDirection="column">
          {LOGO.map((line, index) => (
            <GradientText key={index} text={line} colors={LOGO_GRADIENT} span={logoWidth} />
          ))}
        </Box>
        <Box marginLeft={1}>
          <Badge>v{PACKAGE_VERSION}</Badge>
        </Box>
      </Box>
      <Divider />
    </Box>
  );
}
