import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { useNavigate } from "react-router";
import { Layout } from "./Layout";
import { Spinner } from "./ui/spinner";
import { Confirm } from "./ui/confirm";
import { TaskList, type Task } from "./ui/task-list";
import { KeyValueTable } from "./KeyValueTable";
import { darkTheme } from "./ui/_core.js";
import { driveProgress, type ProgressEvent } from "../tui/progress";

const theme = darkTheme;

export interface SummaryRow {
  label: string;
  value: string;
}

export type ActionResult = SummaryRow[] | { title: string; rows: SummaryRow[] };

export interface ConfirmActionProps {
  // breadcrumb labels the screen.
  breadcrumb: string[];
  // description is shown dimmed after the breadcrumb, e.g. the command's own
  // description so the header matches `--help`.
  description?: string;
  // title heads the summary overlay (usually the resource name).
  title?: string;
  // rows describe the resource the action applies to. With neither title nor
  // rows the overlay is omitted, for an action whose breadcrumb says it all.
  rows?: SummaryRow[];
  // message is the yes/no question (destructive actions default to No). Omit it
  // to skip the confirmation and run the action as soon as the summary loads —
  // for an operation that is safe to start without asking, like a build.
  message?: string;
  // isPending / error reflect the summary fetch backing the overlay.
  isPending: boolean;
  error: Error | null;
  // action performs the confirmed operation and resolves to what the success
  // panel shows: result rows, optionally under a title that replaces
  // successTitle — for an outcome only known once the action has run. A
  // long-running operation may instead return a progress generator — the same
  // AsyncGenerator<ProgressEvent> runWithProgress drives for the headless
  // command — and its steps render as a live task list while it runs, exactly
  // as they do on the command line.
  action: () => Promise<ActionResult> | AsyncGenerator<ProgressEvent, ActionResult>;
  // successTitle heads the success panel (e.g. "Harness deleted") unless the
  // action's result carries its own.
  successTitle: string;
  // runningLabel is the spinner label while the action runs, shown until the
  // action's first progress step arrives (or throughout, for a plain promise).
  runningLabel: string;
  // nextSteps are commands suggested under the success panel, as the create
  // wizard suggests `agentcore project deploy`.
  nextSteps?: string[];
  // onDone is called when the user acknowledges the success panel; doneLabel
  // says where that leads ("continue" by default, "go back" for a screen that
  // returns to a menu).
  onDone: () => void;
  doneLabel?: string;
  // onCancel runs when the confirmation is declined or esc is pressed; defaults
  // to popping the router history, which suits a screen reached from a picker.
  onCancel?: () => void;
}

type Phase =
  | { kind: "confirm" }
  | { kind: "running" }
  | { kind: "success"; title: string; rows: SummaryRow[] }
  | { kind: "error"; message: string };

// ConfirmAction is the shared destructive-action screen body: a summary overlay
// of the target resource, a y/N confirmation (defaulting to No), a spinner
// while the action runs, and a success/error panel. Cancel and esc pop back.
export function ConfirmAction({
  breadcrumb,
  description,
  title,
  rows = [],
  message,
  isPending,
  error,
  action,
  successTitle,
  runningLabel,
  nextSteps,
  onDone,
  doneLabel = "continue",
  onCancel,
}: ConfirmActionProps) {
  const navigate = useNavigate();
  const cancel = onCancel ?? (() => navigate(-1));
  const [phase, setPhase] = useState<Phase>({ kind: "confirm" });
  const confirms = message !== undefined;
  // tasks is the step list a progress-reporting action builds up. It stays on
  // screen through success and error, as the headless command leaves its
  // completed steps in scrollback above the final line.
  const [tasks, setTasks] = useState<Task[]>([]);

  const run = async () => {
    setPhase({ kind: "running" });
    setTasks([]);
    try {
      const result = action();
      const outcome = isProgressGenerator(result)
        ? await driveProgress(result, setTasks)
        : await result;
      const { title, rows } = Array.isArray(outcome)
        ? { title: successTitle, rows: outcome }
        : outcome;
      setPhase({ kind: "success", title, rows });
    } catch (err) {
      setPhase({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  // Without a question there is nothing to wait for: run once the summary is
  // ready. Keyed on isPending/error so it fires exactly once, when they settle.
  useEffect(() => {
    if (!confirms && !isPending && !error && phase.kind === "confirm") void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run is recreated each render; the phase guard makes this idempotent
  }, [confirms, isPending, error, phase.kind]);

  const hints =
    phase.kind === "confirm"
      ? [
          { key: "y/n", label: "confirm" },
          { key: "esc", label: "back" },
          { key: "ctl+c", label: "quit" },
        ]
      : phase.kind === "success"
        ? [{ key: "enter", label: doneLabel }]
        : phase.kind === "running"
          ? // Nothing listens for esc mid-action: an operation in flight is
            // not abandoned by leaving the screen.
            [{ key: "ctl+c", label: "quit" }]
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
          {(title !== undefined || rows.length > 0) && (
            <Box
              flexDirection="column"
              borderStyle="round"
              borderColor={theme.colors.border}
              paddingX={1}
              marginBottom={1}
            >
              {title !== undefined && <Text bold>{title}</Text>}
              {rows.length > 0 && <KeyValueTable items={toItems(rows)} />}
            </Box>
          )}

          {phase.kind === "confirm" && confirms && (
            <Confirm message={message} defaultValue={false} onConfirm={run} onCancel={cancel} />
          )}
          {phase.kind !== "confirm" && tasks.length > 0 && (
            <Box marginBottom={phase.kind === "running" ? 0 : 1}>
              <TaskList tasks={tasks} />
            </Box>
          )}
          {phase.kind === "running" && tasks.length === 0 && <Spinner label={runningLabel} />}
          {phase.kind === "success" && (
            <SuccessBody
              title={phase.title}
              rows={phase.rows}
              nextSteps={nextSteps}
              onDone={onDone}
              doneLabel={doneLabel}
            />
          )}
          {phase.kind === "error" && (
            // With a confirmation, esc returns to the question to try again;
            // without one, returning would run again, so it leaves instead.
            <ErrorBody
              message={phase.message}
              onBack={confirms ? () => setPhase({ kind: "confirm" }) : cancel}
            />
          )}
        </Box>
      )}
    </Layout>
  );
}

// A promise has no Symbol.asyncIterator, so this is a safe discriminator.
function isProgressGenerator(
  result: Promise<ActionResult> | AsyncGenerator<ProgressEvent, ActionResult>,
): result is AsyncGenerator<ProgressEvent, ActionResult> {
  return (
    typeof (result as AsyncGenerator<ProgressEvent, ActionResult>)[Symbol.asyncIterator] ===
    "function"
  );
}

// KeyValueTable takes a record; rows are kept as a list here so callers can
// order them.
function toItems(rows: SummaryRow[]): Record<string, string> {
  return Object.fromEntries(rows.map((row) => [row.label, row.value]));
}

function SuccessBody({
  title,
  rows,
  nextSteps,
  onDone,
  doneLabel,
}: {
  title: string;
  rows: SummaryRow[];
  nextSteps?: string[];
  onDone: () => void;
  doneLabel: string;
}) {
  useInput((_input, key) => {
    if (key.return || key.escape) onDone();
  });

  return (
    <Box flexDirection="column">
      <Text color={theme.colors.success} bold>
        ✔ {title}
      </Text>
      {rows.length > 0 && (
        <Box flexDirection="column" marginTop={1} marginLeft={2}>
          <KeyValueTable items={toItems(rows)} />
        </Box>
      )}
      {nextSteps !== undefined && nextSteps.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.colors.text}>next steps</Text>
          {nextSteps.map((step) => (
            <Text key={step} color={theme.colors.primary}>{`  ${step}`}</Text>
          ))}
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={theme.colors.muted}>
          press <Text color={theme.colors.focus}>enter</Text> to {doneLabel}
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
