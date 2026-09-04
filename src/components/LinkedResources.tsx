import { useState } from "react";
import { Box, Text } from "ink";
import { TreeView, type TreeNode } from "./ui/tree-view";
import { Divider } from "./ui/divider";
import { darkTheme } from "./ui/_core.js";

// A "Linked Resources" tree lists the AgentCore resources reachable from
// somewhere — a project's deployed resources on the status screen, the
// runtime, memory, gateway and credential providers wired to a harness on its
// hub. Rows share one shape: a padded type column, the resource name and a
// muted annotation; enter forwards to the resource's detail route when it has
// one and explains itself otherwise.

export interface LinkedResourceData {
  // route is where enter forwards (query string included, e.g. ?region=);
  // rows without one show `hint` under the tree instead.
  route?: string;
  hint?: string;
}

export type LinkedResourceNode = TreeNode<LinkedResourceData>;

// A row's type label, with how many two-character guide steps the tree draws
// before it (0 on the baseline; see linkedResourceLabel).
export interface TypeColumnEntry {
  type: string;
  guideDepth?: number;
}

// typeColumnWidth is the width of the type column that keeps names aligned
// across these rows: the widest label, counting the guide characters a nested
// row is pushed right by, plus two spaces.
export function typeColumnWidth(entries: (string | TypeColumnEntry)[], min: number = 0): number {
  const widths = entries.map((entry) =>
    typeof entry === "string" ? entry.length : entry.type.length + 2 * (entry.guideDepth ?? 0),
  );
  return Math.max(min, Math.max(...widths, 0)) + 2;
}

// linkedResourceLabel lays out one row's label. Rows nested `guideDepth`
// two-character guide steps below the tree's baseline are pushed right by as
// much, so the column shrinks to keep the names aligned; the type always
// keeps at least one space after it.
export function linkedResourceLabel(
  type: string,
  name: string,
  typeWidth: number,
  guideDepth = 0,
): string {
  return `${type.padEnd(Math.max(typeWidth - 2 * guideDepth, type.length + 1))}${name}`;
}

export interface LinkedResourcesTreeProps {
  nodes: LinkedResourceNode[];
  /** The divider title above the tree. */
  title?: string;
  /** Whether the tree owns the keyboard (and shows the ❯ marker). */
  focus: boolean;
  /** Up on the first row hands focus back; see TreeView's onUpFromFirst. */
  onUpFromFirst?: () => void;
  onOpen: (route: string) => void;
}

// LinkedResourcesTree renders a titled divider, the tree and, once enter lands
// on a row without a detail view, that row's hint beneath it.
export function LinkedResourcesTree({
  nodes,
  title = "linked resources",
  focus,
  onUpFromFirst,
  onOpen,
}: LinkedResourcesTreeProps) {
  const [hint, setHint] = useState<string>();

  const select = (node: LinkedResourceNode) => {
    if (node.data?.route) {
      onOpen(node.data.route);
      return;
    }
    setHint(node.data?.hint);
  };

  return (
    <>
      <Divider title={title} />
      <Box flexDirection="column">
        <TreeView
          nodes={nodes}
          onSelect={select}
          showIcons={false}
          focusMarker
          focus={focus}
          onUpFromFirst={onUpFromFirst}
        />
        {hint !== undefined && (
          <Box marginTop={1}>
            <Text color={darkTheme.colors.muted}>{hint}</Text>
          </Box>
        )}
      </Box>
    </>
  );
}

// hasNestedRows reports whether any row can collapse or expand, which decides
// whether the ←→ key hint is worth showing.
export function hasNestedRows(nodes: LinkedResourceNode[]): boolean {
  return nodes.some((node) => (node.children?.length ?? 0) > 0);
}
