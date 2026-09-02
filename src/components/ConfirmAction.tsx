import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { useNavigate } from "react-router";
import { Layout } from "./Layout";
import { Spinner } from "./ui/spinner";
import { Confirm } from "./ui/confirm";
import { TaskList, type Task } from "./ui/task-list";
import { darkTheme } from "./ui/_core.js";
import { applyProgressEvent, settleProgress, type ProgressEvent } from "../tui/progress";

const theme = darkTheme;

export interface SummaryRow {
  label: string;
  value: string;
}

export interface ConfirmActionProps {
  // breadcrumb labels the screen.
  breadcrumb: string[];
  // description is shown dimmed after the breadcrumb, e.g. the command's own
  // description so the header matches `--help`.
  description?: string;
  // title heads the summary overlay (usually the resource name).
  title: string;
  // rows describe the resource the action applies to.
  rows: SummaryRow[];
  // message is the yes/no question (destructive actions default to No).
  message: string;
  // isPending / error reflect the summary fetch backing the overlay.
  isPending: boolean;
  error: Error | null;
  // action performs the confirmed operation and resolves to result rows shown
  // on the success panel. A long-running operation may instead return a
  // progress generator — the same AsyncGenerator<ProgressEvent> runWithProgress
  // drives for the headless command — and its steps render as a live task list
  // while it runs, exactly as they do on the command line.
  action: () => Promise<SummaryRow[]> | AsyncGenerator<ProgressEvent, SummaryRow[]>;
  // successTitle heads the success panel (e.g. "Harness deleted").
  successTitle: string;
  // runningLabel is the spinner label while the action runs, shown until the
  // action's first progress step arrives (or throughout, for a plain promise).
  runningLabel: string;
  // onDone is called when the user acknowledges the success panel.
  onDone: () => void;
  // onCancel runs when the confirmation is declined or esc is pressed; defaults
  // to popping the router history, which suits a screen reached from a picker.
  onCancel?: () => void;
}

type Phase =
  | { kind: "confirm" }
  | { kind: "running" }
  | { kind: "success"; rows: SummaryRow[] }
  | { kind: "error"; message: string };

// ConfirmAction is the shared destructive-action screen body: a summary overlay
// of the target resource, a y/N confirmation (defaulting to No), a spinner
// while the action runs, and a success/error panel. Cancel and esc pop back.
export function ConfirmAction({
  breadcrumb,
  description,
  title,
  rows,
  message,
  isPending,
  error,
  action,
  successTitle,
  runningLabel,
  onDone,
  onCancel,
}: ConfirmActionProps) {
  const navigate = useNavigate();
  const cancel = onCancel ?? (() => navigate(-1));
  const [phase, setPhase] = useState<Phase>({ kind: "confirm" });
  // tasks is the step list a progress-reporting action builds up. It stays on
  // screen through success and error, as the headless command leaves its
  // completed steps in scrollback above the final line.
  const [tasks, setTasks] = useState<Task[]>([]);

  const run = async () => {
    setPhase({ kind: "running" });
    setTasks([]);
    try {
      const result = action();
      let rows: SummaryRow[];
      if (isProgressGenerator(result)) {
        let next = await result.next();
        while (!next.done) {
          const event = next.value;
          setTasks((current) => applyProgressEvent(current, event));
          next = await result.next();
        }
        rows = next.value;
      } else {
        rows = await result;
      }
      setTasks((current) => settleProgress(current, "done"));
      setPhase({ kind: "success", rows });
    } catch (err) {
      setTasks((current) => settleProgress(current, "failed"));
      setPhase({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  const hints =
    phase.kind === "confirm"
      ? [
          { key: "y/n", label: "confirm" },
          { key: "esc", label: "back" },
          { key: "ctl+c", label: "quit" },
        ]
      : phase.kind === "success"
        ? [{ key: "enter", label: "continue" }]
        : [
            { key: "esc", label: "back" },
            { key: "ctl+c", label: "quit" },
          ];

  return (
    <Layout breadcrumb={breadcrumb} description={description} keyHints={hints}>
      {isPending ? (
        <Spinner label="Loading…" />
      ) : error ? (
        <ErrorBody message={error.message} onBack={cancel} />
      ) : (
        <Box flexDirection="column" paddingX={1}>
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor={theme.colors.border}
            paddingX={1}
            marginBottom={1}
          >
            <Text bold>{title}</Text>
            <SummaryRows rows={rows} />
          </Box>

          {phase.kind === "confirm" && (
            <Confirm message={message} defaultValue={false} onConfirm={run} onCancel={cancel} />
          )}
          {phase.kind !== "confirm" && tasks.length > 0 && (
            <Box marginBottom={phase.kind === "running" ? 0 : 1}>
              <TaskList tasks={tasks} />
            </Box>
          )}
          {phase.kind === "running" && tasks.length === 0 && <Spinner label={runningLabel} />}
          {phase.kind === "success" && (
            <SuccessBody title={successTitle} rows={phase.rows} onDone={onDone} />
          )}
          {phase.kind === "error" && (
            <ErrorBody message={phase.message} onBack={() => setPhase({ kind: "confirm" })} />
          )}
        </Box>
      )}
    </Layout>
  );
}

// A promise has no Symbol.asyncIterator, so this is a safe discriminator.
function isProgressGenerator(
  result: Promise<SummaryRow[]> | AsyncGenerator<ProgressEvent, SummaryRow[]>,
): result is AsyncGenerator<ProgressEvent, SummaryRow[]> {
  return (
    typeof (result as AsyncGenerator<ProgressEvent, SummaryRow[]>)[Symbol.asyncIterator] ===
    "function"
  );
}

// SummaryRows aligns values on a column one past the longest label, so a
// label longer than the old fixed width (a stack output name, say) still has a
// gap before its value.
function SummaryRows({ rows }: { rows: SummaryRow[] }) {
  const width = rows.reduce((max, row) => Math.max(max, row.label.length), 0) + 2;
  return (
    <>
      {rows.map((row) => (
        <Text key={row.label}>
          <Text color={theme.colors.muted}>{row.label.padEnd(width)}</Text>
          {row.value}
        </Text>
      ))}
    </>
  );
}

function SuccessBody({
  title,
  rows,
  onDone,
}: {
  title: string;
  rows: SummaryRow[];
  onDone: () => void;
}) {
  useInput((_input, key) => {
    if (key.return || key.escape) onDone();
  });

  return (
    <Box flexDirection="column">
      <Text color={theme.colors.success} bold>
        ✔ {title}
      </Text>
      <Box flexDirection="column" marginTop={1} marginLeft={2}>
        <SummaryRows rows={rows} />
      </Box>
      <Box marginTop={1}>
        <Text color={theme.colors.muted}>
          press <Text color={theme.colors.focus}>enter</Text> to continue
        </Text>
      </Box>
    </Box>
  );
}

function ErrorBody({ message, onBack }: { message: string; onBack: () => void }) {
  useInput((_input, key) => {
    if (key.escape || key.return) onBack();
  });

  return (
    <Box flexDirection="column">
      <Text color={theme.colors.error}>✗ {message}</Text>
      <Box marginTop={1}>
        <Text color={theme.colors.muted}>press esc to go back</Text>
      </Box>
    </Box>
  );
}
