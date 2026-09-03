import React from "react";
import { Box, Text, useStdout } from "ink";
import cliTruncate from "cli-truncate";
import { darkTheme } from "../_core.js";
import type { InkUITheme } from "../_core.js";
import { Spinner } from "../spinner/Spinner.js";

export type TaskState = "running" | "done" | "failed";

export interface Task {
  title: string;
  state: TaskState;
  /** Recent output lines attributed to this task. Only shown while it runs (or after it fails). */
  tail: string[];
}

export interface TaskListProps {
  tasks: Task[];
  /** Maximum tail lines rendered under a running or failed task. */
  tailLines?: number;
  theme?: InkUITheme;
}

const DEFAULT_TAIL_LINES = 5;

/**
 * A vertical list of long-running steps: a spinner marks the running task, ✓/✕
 * mark finished ones (the Stepper glyph vocabulary), and the running task shows
 * a live tail of its recent output behind a muted `│` gutter. Presentational
 * only — drive it from runWithProgress (src/tui/progress.tsx) or feed it Task
 * state directly. Designed for inline (scrollback) rendering, where a finished
 * task's collapsed tail leaves only its ✓ line behind.
 */
export const TaskList: React.FC<TaskListProps> = ({
  tasks,
  tailLines = DEFAULT_TAIL_LINES,
  theme = darkTheme,
}) => {
  const { stdout } = useStdout();
  // `||`, not `??`: a pty can report 0 columns, which would truncate every
  // tail line to nothing. Match Ink's own layout fallback of 80.
  const columns = stdout?.columns || 80;
  // One line per step: a title left to wrap flex-shrinks the 1-char glyph
  // column to nothing, so the ✓/✕/spinner disappears. The glyph and its
  // trailing space take 2 of the row's columns.
  const title = (task: Task) => cliTruncate(task.title, Math.max(columns - 2, 3));

  return (
    <Box flexDirection="column">
      {tasks.map((task, index) => (
        <Box key={`${index}-${task.title}`} flexDirection="column">
          {task.state === "running" ? (
            <Spinner label={title(task)} theme={theme} />
          ) : (
            <Box>
              <Text color={task.state === "done" ? theme.colors.success : theme.colors.error}>
                {task.state === "done" ? "✓" : "✕"}
              </Text>
              <Text color={theme.colors.text}> {title(task)}</Text>
            </Box>
          )}
          {task.state !== "done" &&
            task.tail.slice(-tailLines).map((line, lineIndex) => (
              <Text key={`${lineIndex}-${line}`} color={theme.colors.muted} wrap="truncate-end">
                {cliTruncate(`  │ ${line}`, columns)}
              </Text>
            ))}
        </Box>
      ))}
    </Box>
  );
};
