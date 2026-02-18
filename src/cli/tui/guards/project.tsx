import { findConfigRoot, getWorkingDirectory } from '../../../lib';
import { FatalError } from '../components';
import { Box, Text, render } from 'ink';
import { dirname, resolve } from 'path';
import React from 'react';

/**
 * Check if the agentcore/ project directory exists.
 * Walks up from baseDir to find the agentcore directory.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function projectExists(baseDir: string = getWorkingDirectory()): boolean {
  return findConfigRoot(baseDir) !== null;
}

/**
 * Check if the current working directory is the project root.
 * Returns the project root path if cwd is a subdirectory, or null if at the root.
 * Returns null if no project is found at all (use projectExists for that check).
 */
// eslint-disable-next-line react-refresh/only-export-components
export function getProjectRootMismatch(baseDir: string = getWorkingDirectory()): string | null {
  const configRoot = findConfigRoot(baseDir);
  if (!configRoot) {
    return null;
  }
  const projectRoot = resolve(dirname(configRoot));
  const resolvedCwd = resolve(baseDir);
  if (resolvedCwd !== projectRoot) {
    return projectRoot;
  }
  return null;
}

interface MissingProjectMessageProps {
  /** If true, shows "create" instead of "agentcore create" (for use inside TUI app) */
  inTui?: boolean;
}

/**
 * Inline message component for missing project.
 * Used within TUI screens to show a notice (not for fatal exits).
 */
export function MissingProjectMessage({ inTui }: MissingProjectMessageProps) {
  const createCommand = inTui ? 'create' : 'agentcore create';
  return (
    <Box flexDirection="column">
      <Text color="red">No agentcore project found.</Text>
      <Text>
        Run <Text color="blue">{createCommand}</Text> first.
      </Text>
    </Box>
  );
}

/**
 * Inline message component for wrong directory.
 * Used within TUI screens to show a notice when the user is in a subdirectory.
 */
export function WrongDirectoryMessage({ projectRoot }: { projectRoot: string }) {
  return (
    <Box flexDirection="column">
      <Text color="red">Please run this command from your project root directory.</Text>
      <Text>
        Project root: <Text color="blue">{projectRoot}</Text>
      </Text>
      <Text>
        Run <Text color="blue">cd {projectRoot}</Text> and try again.
      </Text>
    </Box>
  );
}

/**
 * Guard that checks for project and exits with error message if not found.
 * Also checks that the user is running from the project root directory,
 * not from a subdirectory like app/ or agentcore/.
 *
 * Call this early in command handlers before rendering screens.
 *
 * @param inTui - If true, shows "create" instead of "agentcore create"
 */
// eslint-disable-next-line react-refresh/only-export-components
export function requireProject(inTui = false): void {
  const cwd = getWorkingDirectory();
  const configRoot = findConfigRoot(cwd);

  if (!configRoot) {
    const suggestedCommand = inTui ? 'create' : 'agentcore create';
    render(<FatalError message="No agentcore project found." suggestedCommand={suggestedCommand} />);
    process.exit(1);
  }

  const projectRoot = resolve(dirname(configRoot));
  const resolvedCwd = resolve(cwd);

  if (resolvedCwd !== projectRoot) {
    render(
      <FatalError
        message="Please run this command from your project root directory."
        detail={`You are in: ${resolvedCwd}\nProject root: ${projectRoot}`}
        suggestedCommand={`cd ${projectRoot}`}
      />
    );
    process.exit(1);
  }
}
