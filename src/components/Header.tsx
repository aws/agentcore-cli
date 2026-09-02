import React from "react";
import { Box, Text } from "ink";
import { Divider } from "./ui/divider";
import { darkTheme } from "./ui/_core";

export interface HeaderProps {
  // breadcrumb is the trail of path segments shown at the top of a screen, e.g.
  // ["agentcore", "harness", "get"]. Segments are joined with "→" and the first
  // (the app name) is rendered bold.
  breadcrumb: string[];
  // description is optional trailing text (e.g. the command's description). It is
  // appended after the breadcrumb with the same "→" separator and rendered dimmed.
  description?: string;
}

// Header renders a screen's breadcrumb trail followed by a divider.
export const Header: React.FC<HeaderProps> = ({ breadcrumb, description }) => (
  <Box flexDirection="column" flexShrink={0}>
    <Box paddingLeft={1} paddingRight={1}>
      <Text>
        {breadcrumb.map((segment, i) => (
          <Text key={i}>
            {i > 0 ? " → " : ""}
            <Text bold={i === 0}>{segment}</Text>
          </Text>
        ))}
        {description ? (
          <Text color={darkTheme.colors.muted}>
            {" → "}
            {description}
          </Text>
        ) : null}
      </Text>
    </Box>
    <Divider />
  </Box>
);
