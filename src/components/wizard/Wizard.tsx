import { Children, useCallback, useRef, useState, type ReactNode } from "react";
import { Box, useApp } from "ink";
import { AgentCoreCLIError } from "../../errors";
import { ErrorPanel } from "../ErrorPanel";
import { Layout } from "../Layout";
import { SuccessBody } from "../SuccessBody";
import { Stepper, type Step as StepperStep } from "../ui/stepper";
import { Divider } from "../ui/divider";
import { Spinner } from "../ui/spinner";
import { TaskList, type Task } from "../ui/task-list";
import { driveProgress, isProgressGenerator, type ProgressResult } from "../../tui/progress";
import { isStepElement } from "./Step";
import { WizardProvider, type KeyHint, type WizardControls } from "./context";

export type WizardSubmitResult = ProgressResult<unknown>;

type Phase =
  { kind: "form" } | { kind: "running" } | { kind: "success" } | { kind: "error"; message: string };

export interface WizardProps {
  breadcrumb: string[];
  description?: string;
  children: ReactNode;
  onSubmit: () => WizardSubmitResult;
  onCancel: () => void;
  runningLabel: string;
  successLabel: string;
  successHint?: string;
  successNextSteps?: string[];
  onDone?: () => void;
  doneLabel?: string;
}

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
  doneLabel = "continue",
}: WizardProps) {
  const { exit } = useApp();

  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const [tasks, setTasks] = useState<Task[]>([]);
  const [hints, setHints] = useState<KeyHint[]>([{ key: "enter", label: "continue" }]);

  const stepElements = Children.toArray(children).filter(isStepElement);
  const steps: StepperStep[] = stepElements.map((element) => ({
    key: element.props.stepKey,
    title: element.props.title ?? element.props.stepKey,
  }));
  const seen = new Set<string>();
  for (const step of steps) {
    if (seen.has(step.key)) {
      throw new AgentCoreCLIError(`duplicate <Step stepKey="${step.key}">`, {
        name: "DuplicateWizardStepError",
        meta: { stepKey: step.key },
      });
    }
    seen.add(step.key);
  }

  const [stepKey, setStepKey] = useState<string>(() => steps[0]?.key ?? "");

  const found = steps.findIndex((step) => step.key === stepKey);
  const index = found === -1 ? 0 : found;
  const activeStep = stepElements[index];
  const isLast = index === steps.length - 1;

  const submitting = useRef(false);

  const submit = useCallback(async () => {
    if (submitting.current) return;
    submitting.current = true;
    setPhase({ kind: "running" });
    setTasks([]);
    try {
      const result = onSubmit();
      if (isProgressGenerator(result)) await driveProgress(result, setTasks);
      else await result;
      setPhase({ kind: "success" });
    } catch (error) {
      setPhase({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      submitting.current = false;
    }
  }, [onSubmit]);

  const controls: WizardControls = {
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
  };

  const retryable = tasks.length === 0;

  return (
    <Layout
      breadcrumb={breadcrumb}
      description={description}
      keyHints={footerHints(phase, hints, retryable, doneLabel)}
    >
      <Box flexDirection="column">
        {phase.kind === "form" && (
          <>
            <Box paddingX={1} flexShrink={0}>
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
            {phase.kind === "running" && tasks.length === 0 && <Spinner label={runningLabel} />}
            {phase.kind === "success" && (
              <SuccessBody
                title={successLabel}
                hint={successHint}
                nextSteps={successNextSteps}
                onDone={onDone ?? (() => exit())}
                doneLabel={doneLabel}
              />
            )}
            {phase.kind === "error" && (
              <ErrorPanel
                message={phase.message}
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

function footerHints(
  phase: Phase,
  fieldHints: KeyHint[],
  retryable: boolean,
  doneLabel: string,
): KeyHint[] {
  if (phase.kind === "running") return [{ key: "ctrl+c", label: "quit" }];
  if (phase.kind === "success") return [{ key: "enter", label: doneLabel }];
  if (phase.kind === "error") {
    return [
      ...(retryable ? [{ key: "r", label: "retry" }] : []),
      { key: "esc", label: "back" },
      { key: "ctrl+c", label: "quit" },
    ];
  }
  return [...fieldHints, { key: "esc", label: "back" }, { key: "ctrl+c", label: "quit" }];
}
