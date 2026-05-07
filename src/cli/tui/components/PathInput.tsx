import type { PathType } from '../../../schema';
import { Cursor } from './Cursor';
import { Box, Text, useInput } from 'ink';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { useState } from 'react';

interface PathInputProps {
  onSubmit: (value: string) => void;
  onCancel: () => void;
  placeholder?: string;
  initialValue?: string;
  basePath?: string;
  /** Path type: 'file' shows all entries, 'directory' shows only directories */
  pathType?: PathType;
  /** Maximum number of dropdown items visible before scrolling (default: 8) */
  maxVisibleItems?: number;
  /** Allow the final path segment to not exist (for create workflows). Parent directory must still exist. */
  allowCreate?: boolean;
  /** Show hidden files (dotfiles) in completions (default: false) */
  showHidden?: boolean;
  /** Allow empty input (user presses Enter without selecting a file) */
  allowEmpty?: boolean;
  /** Message shown when user submits empty input (only if allowEmpty is true) */
  emptyHelpText?: string;
}

interface CompletionItem {
  value: string;
  name: string;
  isDirectory: boolean;
}

function parsePath(input: string, basePath: string): { dir: string; prefix: string } {
  if (!input || input === '') {
    return { dir: resolve(basePath), prefix: '' };
  }
  if (input.endsWith('/')) {
    return { dir: resolve(basePath, input), prefix: '' };
  }
  const dir = dirname(resolve(basePath, input));
  const prefix = input.split('/').pop() ?? '';
  return { dir, prefix };
}

function getCompletions(input: string, basePath: string, pathType: PathType, showHidden = false): CompletionItem[] {
  try {
    const { dir, prefix } = parsePath(input, basePath);
    const entries = readdirSync(dir, { withFileTypes: true });

    const items = entries
      .filter(entry => {
        if (!entry.name.toLowerCase().startsWith(prefix.toLowerCase())) return false;
        if (!showHidden && entry.name.startsWith('.')) return false;
        if (pathType === 'directory' && !entry.isDirectory()) return false;
        return true;
      })
      .map(entry => {
        const inputDir = input.endsWith('/') ? input : input.substring(0, input.lastIndexOf('/') + 1);
        const suffix = entry.isDirectory() ? '/' : '';
        return {
          value: inputDir + entry.name + suffix,
          name: entry.name + suffix,
          isDirectory: entry.isDirectory(),
        };
      });

    // Sort: directories first, then files, alphabetically within each group
    return items.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });
  } catch {
    return [];
  }
}

/** Validate that a path exists and matches the expected type */
function validatePath(path: string, basePath: string, pathType: PathType): string | null {
  const resolved = resolve(basePath, path);
  if (!existsSync(resolved)) {
    return `"${path}" is not a valid path`;
  }
  if (pathType === 'directory') {
    try {
      if (!statSync(resolved).isDirectory()) {
        return `"${path}" is not a directory`;
      }
    } catch {
      return `"${path}" is not a valid path`;
    }
  }
  return null; // Valid
}

/** Validate path for create mode: parent directory must exist, final segment can be new */
function validatePathForCreate(path: string, basePath: string): string | null {
  const resolved = resolve(basePath, path);
  const parent = dirname(resolved);

  // Check if path already exists - that's fine for create mode
  if (existsSync(resolved)) {
    try {
      if (!statSync(resolved).isDirectory()) {
        return `"${path}" exists but is not a directory`;
      }
    } catch {
      return `"${path}" is not a valid path`;
    }
    return null; // Existing directory is valid
  }

  // Path doesn't exist - check that parent directory exists
  if (!existsSync(parent)) {
    return `Parent directory "${dirname(path)}" does not exist`;
  }

  try {
    if (!statSync(parent).isDirectory()) {
      return `"${dirname(path)}" is not a directory`;
    }
  } catch {
    return `Parent directory "${dirname(path)}" is not valid`;
  }

  return null; // Valid - parent exists, final segment will be created
}

export function PathInput({
  onSubmit,
  onCancel,
  placeholder,
  initialValue = '',
  basePath = process.cwd(),
  pathType = 'file',
  maxVisibleItems = 8,
  allowCreate = false,
  showHidden = false,
  allowEmpty = false,
  emptyHelpText,
}: PathInputProps) {
  const [value, setValue] = useState(initialValue);
  const [cursor, setCursor] = useState(initialValue.length);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Get live completions based on current value
  const matches = getCompletions(value, basePath, pathType, showHidden);

  // Calculate viewport for scrolling
  const totalItems = matches.length;
  const clampedIndex = Math.min(selectedIndex, Math.max(0, totalItems - 1));

  // Adjust viewport to keep selected item visible
  const halfVisible = Math.floor(maxVisibleItems / 2);
  let viewportStart = Math.max(0, clampedIndex - halfVisible);
  const viewportEnd = Math.min(totalItems, viewportStart + maxVisibleItems);
  // Adjust start if we're near the end
  if (viewportEnd - viewportStart < maxVisibleItems) {
    viewportStart = Math.max(0, viewportEnd - maxVisibleItems);
  }
  const visibleItems = matches.slice(viewportStart, viewportEnd);

  // Helper to select the current highlighted item
  const selectHighlightedItem = () => {
    if (matches.length > 0 && matches[clampedIndex]) {
      const selected = matches[clampedIndex];
      setValue(selected.value);
      setCursor(selected.value.length);
      setSelectedIndex(0);
    }
  };

  // Go back one directory level
  const goBack = () => {
    if (value.endsWith('/')) {
      // Remove trailing slash and go up one level
      const withoutSlash = value.slice(0, -1);
      const lastSlash = withoutSlash.lastIndexOf('/');
      if (lastSlash >= 0) {
        setValue(withoutSlash.slice(0, lastSlash + 1));
        setCursor(lastSlash + 1);
      } else {
        setValue('');
        setCursor(0);
      }
    } else {
      // Go to parent directory
      const lastSlash = value.lastIndexOf('/');
      if (lastSlash >= 0) {
        setValue(value.slice(0, lastSlash + 1));
        setCursor(lastSlash + 1);
      } else {
        setValue('');
        setCursor(0);
      }
    }
    setSelectedIndex(0);
  };

  useInput((input, key) => {
    // Clear error on any input
    if (error) setError(null);

    // Esc: Cancel
    if (key.escape) {
      onCancel();
      return;
    }

    // Enter: If a dropdown item is highlighted, select it first; then validate and submit
    if (key.return) {
      // If there's a highlighted match, auto-select it
      if (matches.length > 0 && matches[clampedIndex]) {
        const selected = matches[clampedIndex];
        if (selected.isDirectory) {
          // Drill into directory
          setValue(selected.value);
          setCursor(selected.value.length);
          setSelectedIndex(0);
          return;
        }
        // It's a file — select and submit it
        const validationError = allowCreate
          ? validatePathForCreate(selected.value, basePath)
          : validatePath(selected.value, basePath, pathType);
        if (validationError) {
          setError(validationError);
          return;
        }
        onSubmit(selected.value);
        return;
      }

      const trimmed = value.trim();
      if (!trimmed) {
        if (allowEmpty) {
          onSubmit('');
          return;
        }
        setError('Please enter a path');
        return;
      }

      const validationError = allowCreate
        ? validatePathForCreate(trimmed, basePath)
        : validatePath(trimmed, basePath, pathType);
      if (validationError) {
        setError(validationError);
        return;
      }
      onSubmit(trimmed);
      return;
    }

    // ↑↓: Move through dropdown
    if (key.upArrow) {
      if (matches.length > 0) {
        setSelectedIndex(i => (i - 1 + matches.length) % matches.length);
      }
      return;
    }
    if (key.downArrow) {
      if (matches.length > 0) {
        setSelectedIndex(i => (i + 1) % matches.length);
      }
      return;
    }

    // →: Open (select highlighted item / drill into directory)
    if (key.rightArrow) {
      selectHighlightedItem();
      return;
    }

    // ←: Back (go up one directory level)
    if (key.leftArrow) {
      goBack();
      return;
    }

    // Backspace: Delete character or go back if at start
    if (key.backspace || key.delete) {
      if (cursor > 0) {
        setValue(value.slice(0, cursor - 1) + value.slice(cursor));
        setCursor(cursor - 1);
        setSelectedIndex(0);
      }
      return;
    }

    // Tab: Same as right arrow (open/drill)
    if (key.tab || input === '\t') {
      selectHighlightedItem();
      return;
    }

    // Regular character input at cursor position
    if (input && !key.ctrl && !key.meta) {
      setValue(value.slice(0, cursor) + input + value.slice(cursor));
      setCursor(cursor + input.length);
      setSelectedIndex(0);
    }
  });

  const pathTypeLabel = pathType === 'directory' ? 'directory' : 'file';
  const hasMatches = matches.length > 0;

  return (
    <Box flexDirection="column">
      <Box>
        <Text dimColor>Select a {pathTypeLabel}:</Text>
      </Box>
      <Box>
        <Text color="cyan">&gt; </Text>
        <Text>{value}</Text>
        <Cursor />
        {!value && <Text dimColor>{placeholder}</Text>}
      </Box>

      {/* Error message */}
      {error && (
        <Box marginTop={1}>
          <Text color="red">{error}</Text>
        </Box>
      )}

      {/* Dropdown menu */}
      {hasMatches && (
        <Box flexDirection="column" marginTop={1} marginLeft={2}>
          {/* Scroll indicator at top */}
          {viewportStart > 0 && <Text dimColor> ↑ {viewportStart} more</Text>}

          {visibleItems.map((item, idx) => {
            const actualIndex = viewportStart + idx;
            const isSelected = actualIndex === clampedIndex;
            const icon = item.isDirectory ? '📁' : '📄';

            return (
              <Box key={item.value}>
                <Text color={isSelected ? 'cyan' : undefined}>{isSelected ? '❯ ' : '  '}</Text>
                <Text>{icon} </Text>
                <Text color={isSelected ? 'cyan' : item.isDirectory ? 'blue' : undefined} bold={isSelected}>
                  {item.name}
                </Text>
              </Box>
            );
          })}

          {/* Scroll indicator at bottom */}
          {viewportEnd < totalItems && <Text dimColor> ↓ {totalItems - viewportEnd} more</Text>}
        </Box>
      )}

      {/* Help text */}
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>↑↓ move → open ← back Enter submit Esc cancel</Text>
        {allowEmpty && emptyHelpText && !value && <Text dimColor>{emptyHelpText}</Text>}
      </Box>
    </Box>
  );
}
