import React from "react";
import { Box } from "ink";
import { useWindowSize } from "./ui/useWindowSize";
import { Header, type HeaderProps } from "./Header";
import { Footer } from "./Footer";
import type { KeyHintProps } from "./ui/key-hint";

export interface LayoutProps {
  // banner is content rendered above the standard breadcrumb header.
  banner?: React.ReactNode;
  // bannerHeight is the number of terminal rows occupied by the banner.
  bannerHeight?: number;
  // hideBanner suppresses the banner regardless of terminal dimensions.
  hideBanner?: boolean;
  // bannerMinColumns/bannerMinRows suppress the banner below these dimensions.
  bannerMinColumns?: number;
  bannerMinRows?: number;
  // breadcrumb is passed through to the Header.
  breadcrumb: HeaderProps["breadcrumb"];
  // description is passed through to the Header, shown dimmed after the breadcrumb.
  description?: HeaderProps["description"];
  // keyHints is passed through to the Footer (KeyHint) row.
  keyHints: KeyHintProps["keys"];
  // children fill the content area between the header and footer.
  children:
    | React.ReactNode
    | ((dimensions: {
        columns: number;
        rows: number;
        contentRows: number;
        bannerVisible: boolean;
      }) => React.ReactNode);
}

const FRAME_ROWS = 4;

// Layout is the standard full-screen frame: a breadcrumb Header at the top, a
// KeyHint Footer at the bottom, and a flexible content area in between that grows
// to fill the remaining terminal height.
export const Layout: React.FC<LayoutProps> = ({
  banner,
  bannerHeight = 0,
  hideBanner = false,
  bannerMinColumns = 0,
  bannerMinRows = 0,
  breadcrumb,
  description,
  keyHints,
  children,
}) => {
  const { columns, rows } = useWindowSize();
  const bannerVisible =
    Boolean(banner) && !hideBanner && columns >= bannerMinColumns && rows >= bannerMinRows;
  const contentRows = Math.max(0, rows - FRAME_ROWS - (bannerVisible ? bannerHeight : 0));
  const content =
    typeof children === "function"
      ? children({ columns, rows, contentRows, bannerVisible })
      : children;

  return (
    <Box width={columns} height={rows} flexDirection="column">
      {bannerVisible ? banner : null}
      <Header breadcrumb={breadcrumb} description={description} />
      <Box flexGrow={1} flexShrink={1} minHeight={0} flexDirection="column">
        {content}
      </Box>
      <Footer keys={keyHints} />
    </Box>
  );
};
