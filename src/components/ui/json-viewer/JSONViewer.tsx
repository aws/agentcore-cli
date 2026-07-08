import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { darkTheme } from "../_core.js";
import type { InkUITheme } from "../_core.js";

export interface JSONViewerProps {
  data: unknown;
  initialDepth?: number;
  maxHeight?: number;
  showTypes?: boolean;
  showIndices?: boolean;
  rootLabel?: string;
  focus?: boolean;
  theme?: InkUITheme;
}

interface JsonNode {
  id: string;
  key: string;
  value: unknown;
  type: "object" | "array" | "string" | "number" | "boolean" | "null";
  depth: number;
  childCount?: number;
  isLast: boolean;
  parentPrefixes: string[];
}

function buildNodes(
  value: unknown,
  key: string,
  depth: number,
  path: string,
  isLast: boolean,
  parentPrefixes: string[],
): JsonNode[] {
  const nodes: JsonNode[] = [];

  if (value === null) {
    nodes.push({ id: path, key, value, type: "null", depth, isLast, parentPrefixes });
  } else if (Array.isArray(value)) {
    nodes.push({
      id: path,
      key,
      value,
      type: "array",
      depth,
      childCount: value.length,
      isLast,
      parentPrefixes,
    });
  } else if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    nodes.push({
      id: path,
      key,
      value,
      type: "object",
      depth,
      childCount: Object.keys(obj).length,
      isLast,
      parentPrefixes,
    });
  } else if (typeof value === "string") {
    nodes.push({ id: path, key, value, type: "string", depth, isLast, parentPrefixes });
  } else if (typeof value === "number") {
    nodes.push({ id: path, key, value, type: "number", depth, isLast, parentPrefixes });
  } else if (typeof value === "boolean") {
    nodes.push({ id: path, key, value, type: "boolean", depth, isLast, parentPrefixes });
  }

  return nodes;
}

export const JSONViewer: React.FC<JSONViewerProps> = ({
  data,
  initialDepth = 1,
  maxHeight,
  // eslint-disable-next-line no-unused-vars
  showTypes = false,
  rootLabel = "root",
  focus = true,
  theme = darkTheme,
}) => {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => {
    const ids = new Set<string>();
    // Expand up to initialDepth
    function collectIds(value: unknown, path: string, depth: number) {
      if (depth >= initialDepth) return;
      if (value !== null && typeof value === "object") {
        ids.add(path);
        if (Array.isArray(value)) {
          value.forEach((v, i) => collectIds(v, `${path}.${i}`, depth + 1));
        } else {
          Object.entries(value as Record<string, unknown>).forEach(([k, v]) =>
            collectIds(v, `${path}.${k}`, depth + 1),
          );
        }
      }
    }
    collectIds(data, "root", 0);
    return ids;
  });

  const [focusedId, setFocusedId] = useState("root");

  // Build flat visible list
  const flatNodes: JsonNode[] = [];

  function traverse(
    value: unknown,
    key: string,
    depth: number,
    path: string,
    isLast: boolean,
    parentPrefixes: string[],
  ) {
    const [node] = buildNodes(value, key, depth, path, isLast, parentPrefixes);
    if (!node) return;
    flatNodes.push(node);

    if ((node.type === "object" || node.type === "array") && expandedIds.has(path)) {
      const newPrefixes = [...parentPrefixes, isLast ? "  " : "│ "];
      if (Array.isArray(value)) {
        value.forEach((v, i) => {
          traverse(
            v,
            String(i),
            depth + 1,
            `${path}.${i}`,
            i === (value as unknown[]).length - 1,
            newPrefixes,
          );
        });
      } else if (value !== null && typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>);
        entries.forEach(([k, v], i) => {
          traverse(v, k, depth + 1, `${path}.${k}`, i === entries.length - 1, newPrefixes);
        });
      }
    }
  }

  traverse(data, rootLabel, 0, "root", true, []);

  const enabledNodes = flatNodes;
  const visible = maxHeight ? flatNodes.slice(0, maxHeight) : flatNodes;

  useInput(
    (input, key) => {
      const currentIdx = enabledNodes.findIndex((n) => n.id === focusedId);
      const current = enabledNodes[currentIdx];

      if (key.upArrow || input === "k") {
        const prev = enabledNodes[Math.max(0, currentIdx - 1)];
        if (prev) setFocusedId(prev.id);
      } else if (key.downArrow || input === "j") {
        const next = enabledNodes[Math.min(enabledNodes.length - 1, currentIdx + 1)];
        if (next) setFocusedId(next.id);
      } else if ((key.rightArrow || input === "l" || input === " ") && current) {
        if (current.type === "object" || current.type === "array") {
          setExpandedIds((prev) => new Set([...prev, current.id]));
        }
      } else if ((key.leftArrow || input === "h") && current) {
        setExpandedIds((prev) => {
          const n = new Set(prev);
          n.delete(current.id);
          return n;
        });
      } else if (input === "g") {
        setFocusedId(enabledNodes[0]?.id ?? "root");
      } else if (input === "G") {
        setFocusedId(enabledNodes[enabledNodes.length - 1]?.id ?? "root");
      }
    },
    { isActive: focus },
  );

  const valueColor = (type: JsonNode["type"]) => {
    switch (type) {
      case "string":
        return theme.colors.success;
      case "number":
        return theme.colors.warning;
      case "boolean":
        return theme.colors.info;
      case "null":
        return theme.colors.muted;
      default:
        return theme.colors.border;
    }
  };

  const renderValue = (node: JsonNode) => {
    if (node.type === "string") return `"${String(node.value)}"`;
    if (node.type === "null") return "null";
    return String(node.value);
  };

  return (
    <Box flexDirection="column">
      {visible.map((node) => {
        const isFocused = node.id === focusedId && focus;
        const isExpanded = expandedIds.has(node.id);
        const isBranch = node.type === "object" || node.type === "array";
        const chevron = isBranch ? (isExpanded ? "▾" : "▸") : " ";
        const guidePrefix =
          node.depth > 0 ? node.parentPrefixes.join("") + (node.isLast ? "└─" : "├─") : "";

        const badge = isBranch
          ? node.type === "array"
            ? ` [${node.childCount}]`
            : ` {${node.childCount}}`
          : "";

        return (
          <Box key={node.id} flexDirection="row">
            {node.depth > 0 && <Text color={theme.colors.border}>{guidePrefix}</Text>}
            <Text
              color={isFocused ? theme.colors.focus : theme.colors.muted}
              bold={isFocused}
              inverse={isFocused}
            >
              <Text color={isBranch ? theme.colors.primary : theme.colors.muted}>{chevron}</Text>{" "}
              <Text color={theme.colors.text}>{node.key}</Text>
              {isBranch ? (
                <Text color={theme.colors.muted}>{badge}</Text>
              ) : (
                <>
                  <Text color={theme.colors.muted}>{": "}</Text>
                  <Text color={valueColor(node.type)}>{renderValue(node)}</Text>
                </>
              )}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
};
