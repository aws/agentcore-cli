import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { Layout } from "../Layout";
import { Stepper, type Step as StepperStep } from "../ui/stepper";
import { Divider } from "../ui/divider";
import { Spinner } from "../ui/spinner";
import { darkTheme } from "../ui/_core.js";
import { isStepElement } from "./Step";
import { WizardProvider, type KeyHint, type WizardControls } from "./context";

const theme = darkTheme;

// ProgressEvent matches ProjectEvent's shape, so a ProjectManager generator can
// be handed to onSubmit unchanged and its messages stream into the event log.
export interface ProgressEvent {
  message: string;
}

// A submit either resolves once (a plain control-plane request) or streams
// progress events (the ProjectManager's async generators). Wizard renders both.
export type WizardSubmitResult = AsyncIterable<ProgressEvent> | Promise<unknown>;

type Phase =
  { kind: "form" } | { kind: "running" } | { kind: "success" } | { kind: "error"; error: Error };

export interface WizardProps {
  breadcrumb: string[];
  // description is shown dimmed after the breadcrumb; pass the command's own
  // description so the header matches what `--help` prints.
  description?: string;
  // children are the <Step>s. A `{condition && <Step/>}` branch is dropped from
  // the flow while the condition is false.
  children: React.ReactNode;
  onSubmit: () => WizardSubmitResult;
  // onCancel runs when esc is pressed on the first step.
  onCancel: () => void;
  // runningLabel is the spinner label shown while onSubmit is in flight.
  runningLabel: string;
  // successLabel is the headline shown once onSubmit resolves.
  successLabel: string;
  // successHint is an optional dimmed line under successLabel.
  successHint?: string;
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
  onDone,
  onError = "exit",
}: WizardProps) {
  const { exit } = useApp();

  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const [events, setEvents] = useState<string[]>([]);
  // Fields publish their hints from an effect, which lands one paint after the
  // first render. Seeding with the hint every field shares keeps that first
  // frame from showing a footer with no action key in it.
  const [hints, setHints] = useState<KeyHint[]>([{ key: "enter", label: "continue" }]);

  const stepElements = useMemo(
    () => React.Children.toArray(children).filter(isStepElement),
    [children],
  );

  const steps: StepperStep[] = useMemo(
    () =>
      stepElements.map((element) => ({
        key: element.props.name,
        title: element.props.title ?? element.props.name,
      })),
    [stepElements],
  );

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
    try {
      const result = onSubmit();
      if (isProgressStream(result)) {
        for await (const event of result) {
          setEvents((current) => [...current, event.message]);
        }
      } else {
        await result;
      }
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

  return (
    <Layout breadcrumb={breadcrumb} description={description} keyHints={footerHints(phase, hints)}>
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
            <EventLog events={events} />
            {phase.kind === "running" && <Spinner label={runningLabel} />}
            {phase.kind === "success" && (
              <SuccessPanel
                label={successLabel}
                hint={successHint}
                onContinue={onDone ?? (() => exit())}
              />
            )}
            {phase.kind === "error" && onError === "exit" && <ExitOnError error={phase.error} />}
            {phase.kind === "error" && onError === "retry" && (
              <RetryPanel error={phase.error} onBack={() => setPhase({ kind: "form" })} />
            )}
          </Box>
        )}
      </Box>
    </Layout>
  );
}

// isProgressStream distinguishes an async generator from a promise. A promise
// has no Symbol.asyncIterator, so this is a safe discriminator.
function isProgressStream(result: WizardSubmitResult): result is AsyncIterable<ProgressEvent> {
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
function footerHints(phase: Phase, fieldHints: KeyHint[]): KeyHint[] {
  if (phase.kind === "running") return [{ key: "ctl+c", label: "quit" }];
  if (phase.kind === "success") return [{ key: "enter", label: "continue" }];
  if (phase.kind === "error") {
    return [
      { key: "esc", label: "back" },
      { key: "ctl+c", label: "quit" },
    ];
  }
  return [...fieldHints, { key: "esc", label: "back" }, { key: "ctl+c", label: "quit" }];
}

function EventLog({ events }: { events: string[] }) {
  return (
    <Box flexDirection="column">
      {events.map((message, i) => (
        <Text key={`${i}-${message}`} color={theme.colors.muted}>
          ✓ {message}
        </Text>
      ))}
    </Box>
  );
}

function SuccessPanel({
  label,
  hint,
  onContinue,
}: {
  label: string;
  hint?: string;
  onContinue: () => void;
}) {
  useInput((_input, key) => {
    if (key.return || key.escape) onContinue();
  });

  return (
    <Box flexDirection="column">
      <Text color={theme.colors.success} bold>
        ✔ {label}
      </Text>
      {hint !== undefined && <Text color={theme.colors.muted}>{hint}</Text>}
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

  return <Text color={theme.colors.error}>✗ {error.message}</Text>;
}

function RetryPanel({ error, onBack }: { error: Error; onBack: () => void }) {
  useInput((_input, key) => {
    if (key.escape || key.return) onBack();
  });

  return (
    <Box flexDirection="column">
      <Text color={theme.colors.error}>✗ {error.message}</Text>
      <Text color={theme.colors.muted}>esc returns to the form</Text>
    </Box>
  );
}
