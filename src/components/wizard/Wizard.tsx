import { Children, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { ErrorPanel } from "../ErrorPanel";
import { Layout } from "../Layout";
import { Stepper, type Step as StepperStep } from "../ui/stepper";
import { Divider } from "../ui/divider";
import { Spinner } from "../ui/spinner";
import { TaskList, type Task } from "../ui/task-list";
import { darkTheme, glyphs } from "../ui/_core.js";
import { driveProgress, type ProgressEvent } from "../../tui/progress";
import { isStepElement } from "./Step";
import { WizardProvider, type KeyHint, type WizardControls } from "./context";

const theme = darkTheme;

// A submit either resolves once (a plain control-plane request) or streams
// progress events (the ProjectManager's async generators). Wizard renders both.
export type WizardSubmitResult = AsyncGenerator<ProgressEvent, unknown> | Promise<unknown>;

type Phase =
  { kind: "form" } | { kind: "running" } | { kind: "success" } | { kind: "error"; error: Error };

export interface WizardProps {
  breadcrumb: string[];
  // description is shown dimmed after the breadcrumb; pass the command's own
  // description so the header matches what `--help` prints.
  description?: string;
  // children are the <Step>s. A `{condition && <Step/>}` branch is dropped from
  // the flow while the condition is false.
  children: ReactNode;
  onSubmit: () => WizardSubmitResult;
  // onCancel runs when esc is pressed on the first step.
  onCancel: () => void;
  // runningLabel is the spinner label shown while onSubmit is in flight.
  runningLabel: string;
  // successLabel is the headline shown once onSubmit resolves.
  successLabel: string;
  // successHint is an optional dimmed line under successLabel.
  successHint?: string;
  // successNextSteps are the commands to run next, listed under successLabel —
  // the same block ConfirmAction shows after a successful action.
  successNextSteps?: string[];
  // onDone runs when the success panel is acknowledged; defaults to tearing the
  // TUI down, which is what a one-shot `project add ...` wants.
  onDone?: () => void;
  // onError decides what a failure does. "exit" rejects the waitUntilExit()
  // that renderTuiAt awaits, so the error takes the normal CLI path and the
  // process exits nonzero — right for a one-shot command. "retry" reports the
  // message and returns to the form, right for a screen the user navigated to.
  onError?: "exit" | "retry";
}

// Wizard is the shared shell behind every step-based flow: it derives the step
// list from its <Step> children, owns position, key handling and the
// form → running → success | error phases, and renders the standard
// Layout + Stepper frame. Screens supply only the questions.
export function Wizard({
  breadcrumb,
  description,
  children,
  onSubmit,
  onCancel,
  runningLabel,
  successLabel,
  successHint,
  successNextSteps,
  onDone,
  onError = "exit",
}: WizardProps) {
  const { exit } = useApp();

  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const [tasks, setTasks] = useState<Task[]>([]);
  // Fields publish their hints from an effect, which lands one paint after the
  // first render. Seeding with the hint every field shares keeps that first
  // frame from showing a footer with no action key in it.
  const [hints, setHints] = useState<KeyHint[]>([{ key: "enter", label: "continue" }]);

  const stepElements = useMemo(() => Children.toArray(children).filter(isStepElement), [children]);

  const steps: StepperStep[] = useMemo(() => {
    const list = stepElements.map((element) => ({
      key: element.props.name,
      title: element.props.title ?? element.props.name,
    }));
    // Position is keyed by name, so two steps sharing one would make advance()
    // land on the first of them forever. Catch that at render time, where the
    // author sees it, instead of as a wizard that quietly cannot move on.
    const seen = new Set<string>();
    for (const step of list) {
      if (seen.has(step.key)) throw new Error(`duplicate <Step name="${step.key}">`);
      seen.add(step.key);
    }
    return list;
  }, [stepElements]);

  const [stepKey, setStepKey] = useState<string>(() => steps[0]?.key ?? "");

  // Position is a key, not an index, so a branch that adds or removes steps
  // does not move the user. The clamp covers the one case a key can vanish:
  // a branch closing while its own step is somehow still active.
  const found = steps.findIndex((step) => step.key === stepKey);
  const index = found === -1 ? 0 : found;
  const activeStep = stepElements[index];
  const isLast = index === steps.length - 1;

  // Ink drains buffered keystrokes synchronously, so a second enter can arrive
  // before the form unmounts. The ref makes submitting idempotent.
  const submitting = useRef(false);

  const submit = useCallback(async () => {
    if (submitting.current) return;
    submitting.current = true;
    setPhase({ kind: "running" });
    setTasks([]);
    try {
      const result = onSubmit();
      // Same driver as create, build and deploy: driveProgress folds the stream
      // into the Task list TaskList draws, so a wizard's steps look like every
      // other long-running operation's — spinner on the running step, a tail of
      // its output, ✓ once it settles.
      if (isProgressStream(result)) await driveProgress(result, setTasks);
      else await result;
      setPhase({ kind: "success" });
    } catch (error) {
      setPhase({ kind: "error", error: toError(error) });
    } finally {
      submitting.current = false;
    }
  }, [onSubmit]);

  const controls: WizardControls = useMemo(
    () => ({
      isLast,
      setHints,
      advance: () => {
        if (isLast) {
          void submit();
          return;
        }
        const next = steps[index + 1];
        if (next) setStepKey(next.key);
      },
      back: () => {
        if (index === 0) {
          onCancel();
          return;
        }
        const previous = steps[index - 1];
        if (previous) setStepKey(previous.key);
      },
    }),
    [isLast, index, steps, submit, onCancel],
  );

  // A retry is only offered while nothing has been written yet: once a step has
  // run, the operation is partly applied and re-submitting would fail on what
  // it already did.
  const retryable = onError === "retry" && tasks.length === 0;

  return (
    <Layout
      breadcrumb={breadcrumb}
      description={description}
      keyHints={footerHints(phase, hints, retryable)}
    >
      <Box flexDirection="column">
        {phase.kind === "form" && (
          <>
            <Box paddingX={1}>
              <Stepper
                steps={steps}
                currentStep={steps[index]?.key ?? ""}
                completedSteps={steps.slice(0, index).map((step) => step.key)}
              />
            </Box>
            <Divider />
            <WizardProvider value={controls}>{activeStep}</WizardProvider>
          </>
        )}

        {phase.kind !== "form" && (
          <Box flexDirection="column" paddingX={1}>
            <TaskList tasks={tasks} />
            {/* A submit that reports no steps at all — a plain request, or a
                stream before its first step — still needs something moving. */}
            {phase.kind === "running" && tasks.length === 0 && <Spinner label={runningLabel} />}
            {phase.kind === "success" && (
              <SuccessPanel
                label={successLabel}
                hint={successHint}
                nextSteps={successNextSteps}
                onContinue={onDone ?? (() => exit())}
              />
            )}
            {phase.kind === "error" && onError === "exit" && <ExitOnError error={phase.error} />}
            {phase.kind === "error" && onError === "retry" && (
              <ErrorPanel
                message={phase.error.message}
                onRetry={retryable ? () => void submit() : undefined}
                onBack={() => setPhase({ kind: "form" })}
              />
            )}
          </Box>
        )}
      </Box>
    </Layout>
  );
}

// isProgressStream distinguishes an async generator from a promise. A promise
// has no Symbol.asyncIterator, so this is a safe discriminator.
function isProgressStream(
  result: WizardSubmitResult,
): result is AsyncGenerator<ProgressEvent, unknown> {
  return (
    result !== null &&
    typeof result === "object" &&
    typeof (result as AsyncIterable<ProgressEvent>)[Symbol.asyncIterator] === "function"
  );
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

// footerHints appends the keys that mean the same thing on every step to
// whatever the active field published.
function footerHints(phase: Phase, fieldHints: KeyHint[], retryable: boolean): KeyHint[] {
  if (phase.kind === "running") return [{ key: "ctrl+c", label: "quit" }];
  if (phase.kind === "success") return [{ key: "enter", label: "continue" }];
  if (phase.kind === "error") {
    return [
      ...(retryable ? [{ key: "r", label: "retry" }] : []),
      { key: "esc", label: "back" },
      { key: "ctrl+c", label: "quit" },
    ];
  }
  return [...fieldHints, { key: "esc", label: "back" }, { key: "ctrl+c", label: "quit" }];
}

function SuccessPanel({
  label,
  hint,
  nextSteps,
  onContinue,
}: {
  label: string;
  hint?: string;
  nextSteps?: string[];
  onContinue: () => void;
}) {
  useInput((_input, key) => {
    if (key.return || key.escape) onContinue();
  });

  return (
    <Box flexDirection="column">
      <Text color={theme.colors.success} bold>
        {glyphs.check} {label}
      </Text>
      {nextSteps !== undefined && nextSteps.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.colors.text}>next steps</Text>
          {nextSteps.map((step) => (
            <Text key={step} color={theme.colors.primary}>{`  ${step}`}</Text>
          ))}
        </Box>
      )}
      {hint !== undefined && (
        <Box marginTop={nextSteps === undefined ? 0 : 1}>
          <Text color={theme.colors.muted}>{hint}</Text>
        </Box>
      )}
    </Box>
  );
}

// ExitOnError tears the TUI down through exit(error): that rejects the
// waitUntilExit() renderTuiAt awaits, so the failure is reported by the normal
// CLI error path instead of as a React stack trace.
function ExitOnError({ error }: { error: Error }) {
  const { exit } = useApp();

  useEffect(() => {
    exit(error);
  }, [exit, error]);

  return (
    <Text color={theme.colors.error}>
      {glyphs.cross} {error.message}
    </Text>
  );
}
