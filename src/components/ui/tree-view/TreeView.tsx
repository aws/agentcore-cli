import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { darkTheme, glyphs } from "../_core.js";
import type { InkUITheme } from "../_core.js";

export interface TreeNode<T = unknown> {
  id: string;
  label: string;
  /** Muted text rendered after the label (e.g. a status or description). */
  annotation?: string;
  children?: TreeNode<T>[];
  icon?: string;
  defaultExpanded?: boolean;
  disabled?: boolean;
  data?: T;
}

export interface TreeViewProps<T = unknown> {
  nodes: TreeNode<T>[];
  onSelect?: (node: TreeNode<T>) => void;
  onToggle?: (node: TreeNode<T>, expanded: boolean) => void;
  maxHeight?: number;
  guides?: boolean;
  showIcons?: boolean;
  leafIcon?: string;
  branchIcon?: string;
  branchOpenIcon?: string;
  /**
   * Mark the focused row with a pointer prefix in the focus color instead of
   * inverse video, matching the selection style of DataTable and the menus.
   */
  focusMarker?: boolean;
  focus?: boolean;
  /**
   * Called when up (or k) is pressed while the first enabled row is focused,
   * so a parent that stacks the tree under another list can hand focus back
   * to it. Without it the press is a no-op, as before.
   */
  onUpFromFirst?: () => void;
  theme?: InkUITheme;
}

interface FlatNode<T> {
  node: TreeNode<T>;
  depth: number;
  isLast: boolean;
  parentPrefixes: string[];
}

function flatten<T>(
  nodes: TreeNode<T>[],
  expandedIds: Set<string>,
  depth = 0,
  parentPrefixes: string[] = [],
): FlatNode<T>[] {
  const result: FlatNode<T>[] = [];
  nodes.forEach((node, i) => {
    const isLast = i === nodes.length - 1;
    result.push({ node, depth, isLast, parentPrefixes });
    if (node.children && expandedIds.has(node.id)) {
      const newPrefixes = [...parentPrefixes, isLast ? "  " : "│ "];
      result.push(...flatten(node.children, expandedIds, depth + 1, newPrefixes));
    }
  });
  return result;
}

export function TreeView<T = unknown>({
  nodes,
  onSelect,
  onToggle,
  maxHeight,
  guides = true,
  showIcons = true,
  leafIcon = glyphs.file,
  branchIcon = glyphs.folder,
  branchOpenIcon = glyphs.folderOpen,
  focusMarker = false,
  focus = true,
  onUpFromFirst,
  theme = darkTheme,
}: TreeViewProps<T>): React.ReactElement {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(
    new Set(
      flatAll(nodes)
        .filter((n) => n.defaultExpanded)
        .map((n) => n.id),
    ),
  );
  const [focusedId, setFocusedId] = useState<string>(nodes[0]?.id ?? "");

  const flatNodes = flatten(nodes, expandedIds);
  const visible = maxHeight ? flatNodes.slice(0, maxHeight) : flatNodes;
  const enabledFlat = flatNodes.filter((f) => !f.node.disabled);

  useInput(
    (input, key) => {
      const currentIdx = enabledFlat.findIndex((f) => f.node.id === focusedId);
      const current = flatNodes.find((f) => f.node.id === focusedId);

      if (key.upArrow || input === "k") {
        // Nothing above the first enabled row (or no valid focus yet): let the
        // parent take focus back when it asked to.
        if (currentIdx <= 0 && onUpFromFirst) {
          onUpFromFirst();
          return;
        }
        const prev = enabledFlat[Math.max(0, currentIdx - 1)];
        if (prev) setFocusedId(prev.node.id);
      } else if (key.downArrow || input === "j") {
        const next = enabledFlat[Math.min(enabledFlat.length - 1, currentIdx + 1)];
        if (next) setFocusedId(next.node.id);
      } else if (key.rightArrow || input === "l" || key.return) {
        if (current?.node.children?.length) {
          if (!expandedIds.has(current.node.id)) {
            setExpandedIds((prev) => new Set([...prev, current.node.id]));
            onToggle?.(current.node, true);
          } else {
            onSelect?.(current.node);
          }
        } else if (current) {
          onSelect?.(current.node);
        }
      } else if (key.leftArrow || input === "h") {
        if (current?.node.children && expandedIds.has(current.node.id)) {
          setExpandedIds((prev) => {
            const n = new Set(prev);
            n.delete(current.node.id);
            return n;
          });
          onToggle?.(current.node, false);
        }
      } else if (input === " ") {
        if (current?.node.children) {
          const expanded = expandedIds.has(current.node.id);
          setExpandedIds((prev) => {
            const n = new Set(prev);
            // eslint-disable-next-line no-unused-expressions
            expanded ? n.delete(current.node.id) : n.add(current.node.id);
            return n;
          });
          onToggle?.(current.node, !expanded);
        }
      } else if (input === "g") {
        const first = enabledFlat[0];
        if (first) setFocusedId(first.node.id);
      } else if (input === "G") {
        const last = enabledFlat[enabledFlat.length - 1];
        if (last) setFocusedId(last.node.id);
      }
    },
    { isActive: focus },
  );

  return (
    <Box flexDirection="column">
      {visible.map(({ node, depth, isLast, parentPrefixes }) => {
        const isFocused = node.id === focusedId && focus;
        const isExpanded = expandedIds.has(node.id);
        const hasBranch = Boolean(node.children?.length);

        const branchChar = hasBranch ? (isExpanded ? "▾" : "▸") : " ";
        const icon = showIcons
          ? (node.icon ?? (hasBranch ? (isExpanded ? branchOpenIcon : branchIcon) : leafIcon))
          : "";

        const guidePrefix = guides
          ? parentPrefixes.join("") + (depth > 0 ? (isLast ? "└─" : "├─") : "")
          : "";

        return (
          <Box key={node.id} flexDirection="row">
            {focusMarker && (
              <Text color={theme.colors.focus}>{isFocused ? `${glyphs.pointer} ` : "  "}</Text>
            )}
            {guides && depth > 0 && <Text color={theme.colors.border}>{guidePrefix}</Text>}
            <Text
              color={
                isFocused
                  ? theme.colors.focus
                  : node.disabled
                    ? theme.colors.muted
                    : theme.colors.text
              }
              bold={isFocused}
              dimColor={node.disabled}
              inverse={isFocused && !focusMarker}
            >
              <Text color={hasBranch ? theme.colors.primary : theme.colors.muted}>
                {branchChar}
              </Text>
              {showIcons ? ` ${icon} ` : ""}
              {node.label}
            </Text>
            {node.annotation !== undefined && (
              <Text color={theme.colors.muted} dimColor={node.disabled}>
                {" "}
                {node.annotation}
              </Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

function flatAll<T>(nodes: TreeNode<T>[]): TreeNode<T>[] {
  return nodes.flatMap((n) => [n, ...(n.children ? flatAll(n.children) : [])]);
}
