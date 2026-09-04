import React from "react";
import { Box, useWindowSize } from "ink";
import { Header, type HeaderProps } from "./Header";
import { Footer } from "./Footer";
import type { KeyHintProps } from "./ui/key-hint";

export interface LayoutProps {
  // banner is content rendered above the standard breadcrumb header.
  banner?: React.ReactNode;
  // breadcrumb is passed through to the Header.
  breadcrumb: HeaderProps["breadcrumb"];
  // description is passed through to the Header, shown dimmed after the breadcrumb.
  description?: HeaderProps["description"];
  // keyHints is passed through to the Footer (KeyHint) row.
  keyHints: KeyHintProps["keys"];
  // children fill the content area between the header and footer.
  children: React.ReactNode;
}

// Layout is the standard full-screen frame: a breadcrumb Header at the top, a
// KeyHint Footer at the bottom, and a flexible content area in between that grows
// to fill the remaining terminal height.
export const Layout: React.FC<LayoutProps> = ({
  banner,
  breadcrumb,
  description,
  keyHints,
  children,
}) => {
  const { columns, rows } = useWindowSize();

  return (
    <Box width={columns} height={rows} flexDirection="column">
      {banner}
      <Header breadcrumb={breadcrumb} description={description} />
      <Box flexGrow={1} flexShrink={1} minHeight={0} flexDirection="column">
        {children}
      </Box>
      <Footer keys={keyHints} />
    </Box>
  );
};
