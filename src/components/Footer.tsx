import React from "react";
import { Box } from "ink";
import { Divider } from "./ui/divider";
import { KeyHint, type KeyHintProps } from "./ui/key-hint";

// Footer renders a divider above a KeyHint row. It takes the same props as
// KeyHint so screens can declare their key hints directly.
export const Footer: React.FC<KeyHintProps> = (props) => (
  <Box flexDirection="column" flexShrink={0}>
    <Divider />
    <KeyHint {...props} />
  </Box>
);
