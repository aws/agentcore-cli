import { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { useNavigate } from "react-router";
import { ProjectNameSchema } from "../../../projectSchemas/project";
import type { ScreenProps } from "../../types";
import type { CreateProjectInput } from "../types";
import { DEFAULT_HARNESS_MODEL } from "../add/harness";
import {
  resolveRuntimeTemplateShortcut,
  type MemoryShortcutName,
  type RuntimeTemplateShortcutName,
} from "../shortcuts";
import { resolveScaffoldHarnessInput } from "./index";
import { Layout } from "../../../components/Layout";
import { FormTextInput } from "../../../components/FormTextInput";
import { FormRadioGroup, type FormRadioOption } from "../../../components/FormRadioGroup";
import { KeyValueTable } from "../../../components/KeyValueTable";
import { Stepper, type Step } from "../../../components/ui/stepper";
import { Spinner } from "../../../components/ui/spinner";
import { Divider } from "../../../components/ui/divider";
import { darkTheme } from "../../../components/ui/_core.js";

const theme = darkTheme;

// ─── form model ───────────────────────────────────────────────────────────────

// ProjectKind mirrors the headless dispatch: a project is created around either
// a harness (the default) or scaffolded runtime code.
type ProjectKind = "harness" | "agent";

interface CreateProjectFormValues {
  name: string;
  kind: ProjectKind;
  // modelId configures the harness path; everything else uses defaults.
  modelId: string;
  // template + memory configure the agent path; memory applies to strands only.
  template: RuntimeTemplateShortcutName;
  memory: MemoryShortcutName;
}

function emptyCreateProjectForm(): CreateProjectFormValues {
  return {
    name: "",
    kind: "harness",
    modelId: DEFAULT_HARNESS_MODEL.modelId,
    template: "strands-python",
    memory: "longAndShortTerm",
  };
}

const PROJECT_KIND_OPTIONS: { kind: ProjectKind; label: string; description: string }[] = [
  {
    kind: "harness",
    label: "harness (recommended)",
    description: "a managed agent configured by spec — no agent-loop code to maintain",
  },
  {
    kind: "agent",
    label: "scaffolded agent code",
    description: "generate runnable agent code from a template",
  },
];

const TEMPLATE_OPTIONS: {
  template: RuntimeTemplateShortcutName;
  label: string;
  description: string;
}[] = [
  {
    template: "hello-world-python",
    label: "hello-world-python",
    description: "minimal Python agent on Bedrock, no framework (CodeZip build)",
  },
  {
    template: "hello-world-python-container",
    label: "hello-world-python-container",
    description: "the hello-world agent packaged as a container image",
  },
  {
    template: "strands-python",
    label: "strands-python (recommended)",
    description: "Strands agent on Bedrock with memory (CodeZip build)",
  },
];

const MEMORY_OPTIONS: { memory: MemoryShortcutName; label: string; description: string }[] = [
  { memory: "none", label: "none", description: "no memory resources" },
  {
    memory: "shortTerm",
    label: "short-term",
    description: "raw session events, 30-day expiry",
  },
  {
    memory: "longAndShortTerm",
    label: "long and short-term",
    description: "session events plus long-term memory strategies (recommended)",
  },
];

// buildCreateInput translates the form into the same CreateProjectInput the
// flag-driven `project create` builds: the harness path reuses its
// resolveScaffoldHarnessInput translation and the agent path resolves the same
// template shortcuts, so the wizard cannot drift from the headless CLI.
export function buildCreateInput(values: CreateProjectFormValues): CreateProjectInput {
  if (values.kind === "harness") {
    return {
      name: values.name,
      skipInstall: false,
      skipGit: false,
      scaffoldHarnessInput: resolveScaffoldHarnessInput({
        name: values.name,
        "model-id": values.modelId,
      }),
    };
  }
  return {
    name: values.name,
    skipInstall: false,
    skipGit: false,
    scaffoldRuntimeInput: resolveRuntimeTemplateShortcut(
      values.template,
      // Memory is a strands question; the hello-world templates keep their own
      // (memory-less) defaults, exactly like `--template` without `--memory`.
      values.template === "strands-python" ? { memory: values.memory } : undefined,
    ),
  };
}

// summaryOf renders the review table: what will be created, and where.
function summaryOf(values: CreateProjectFormValues): Record<string, string> {
  const base = { project: values.name, directory: `./${values.name}` };
  if (values.kind === "harness") {
    return { ...base, type: "harness", model: values.modelId };
  }
  const withTemplate = { ...base, type: "agent code", template: values.template };
  return values.template === "strands-python"
    ? { ...withTemplate, memory: values.memory }
    : withTemplate;
}

// ─── wizard shell ─────────────────────────────────────────────────────────────

type WizardPhase =
  { kind: "form" } | { kind: "running" } | { kind: "success" } | { kind: "error"; error: Error };

// ProjectCreateScreen is the interactive flow behind a bare `agentcore project
// create`: name → type → (model | template [→ memory]) → review, then the
// creation itself, streaming the ProjectManager's progress events. It drives
// core.projectManager.create with the same input the flag-driven handler
// builds, so both entry points scaffold identical projects — in the current
// working directory, npm install and git init included.
export function ProjectCreateScreen({ core }: ScreenProps) {
  const navigate = useNavigate();
  const { exit } = useApp();

  const [values, setValues] = useState<CreateProjectFormValues>(emptyCreateProjectForm);
  const [stepIndex, setStepIndex] = useState(0);
  const [phase, setPhase] = useState<WizardPhase>({ kind: "form" });
  const [events, setEvents] = useState<string[]>([]);

  // The step list is dynamic: the branch chosen on the type step decides
  // whether model or template (and, for strands, memory) questions follow.
  const steps: Step[] = useMemo(() => {
    const branch: Step[] =
      values.kind === "harness"
        ? [{ key: "model", title: "model" }]
        : [
            { key: "template", title: "template" },
            ...(values.template === "strands-python" ? [{ key: "memory", title: "memory" }] : []),
          ];
    return [
      { key: "name", title: "name" },
      { key: "type", title: "type" },
      ...branch,
      { key: "review", title: "review" },
    ];
  }, [values.kind, values.template]);

  const stepKey = steps[stepIndex]!.key;
  const patch = (update: Partial<CreateProjectFormValues>) =>
    setValues((current) => ({ ...current, ...update }));

  const next = () => setStepIndex((i) => Math.min(steps.length - 1, i + 1));
  const back = () => {
    // Esc from the first step leaves the wizard for the project menu, the
    // same place RouterScreen's esc goes; deeper steps step backwards.
    if (stepIndex === 0) navigate("/agentcore/project");
    else setStepIndex((i) => i - 1);
  };

  const submit = async () => {
    let input: CreateProjectInput;
    try {
      input = buildCreateInput(values);
    } catch (error) {
      setPhase({ kind: "error", error: toError(error) });
      return;
    }
    setPhase({ kind: "running" });
    try {
      for await (const event of core.projectManager.create(input)) {
        setEvents((current) => [...current, event.message]);
      }
      setPhase({ kind: "success" });
    } catch (error) {
      setPhase({ kind: "error", error: toError(error) });
    }
  };

  return (
    <Layout breadcrumb={["agentcore", "project", "create"]} keyHints={hintsFor(stepKey, phase)}>
      <Box flexDirection="column">
        {phase.kind === "form" && (
          <>
            <Box paddingX={1}>
              <Stepper
                steps={steps}
                currentStep={stepKey}
                completedSteps={steps.slice(0, stepIndex).map((step) => step.key)}
              />
            </Box>
            <Divider />
            <WizardStep
              stepKey={stepKey}
              values={values}
              patch={patch}
              onNext={next}
              onBack={back}
              onSubmit={submit}
            />
          </>
        )}
        {phase.kind !== "form" && (
          <Box flexDirection="column" paddingX={1}>
            <EventLog events={events} />
            {phase.kind === "running" && <Spinner label={`creating ${values.name}…`} />}
            {phase.kind === "success" && (
              <SuccessPanel name={values.name} onContinue={() => exit()} />
            )}
            {phase.kind === "error" && <ErrorPanel error={phase.error} />}
          </Box>
        )}
      </Box>
    </Layout>
  );
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function hintsFor(stepKey: string, phase: WizardPhase): { key: string; label: string }[] {
  if (phase.kind === "running") return [{ key: "ctl+c", label: "quit" }];
  if (phase.kind === "success") return [{ key: "enter", label: "exit" }];
  if (phase.kind === "error") return [{ key: "ctl+c", label: "quit" }];
  const base = [
    { key: "esc", label: "back" },
    { key: "ctl+c", label: "quit" },
  ];
  switch (stepKey) {
    case "name":
    case "model":
      return [{ key: "enter", label: "continue" }, ...base];
    case "type":
    case "template":
    case "memory":
      return [{ key: "↑↓", label: "choose" }, { key: "enter", label: "continue" }, ...base];
    case "review":
      return [{ key: "enter", label: "create" }, ...base];
    default:
      return base;
  }
}

// ─── steps ────────────────────────────────────────────────────────────────────

interface WizardStepProps {
  stepKey: string;
  values: CreateProjectFormValues;
  patch: (update: Partial<CreateProjectFormValues>) => void;
  onNext: () => void;
  onBack: () => void;
  onSubmit: () => void;
}

function WizardStep({ stepKey, values, patch, onNext, onBack, onSubmit }: WizardStepProps) {
  switch (stepKey) {
    case "name":
      return (
        <NameStep
          value={values.name}
          onChange={(name) => patch({ name })}
          onNext={onNext}
          onBack={onBack}
        />
      );
    case "type":
      return (
        <RadioStep
          name="what should the project be built around?"
          helpText="a project deploys either a managed harness or your own agent code"
          options={PROJECT_KIND_OPTIONS}
          selectedIndex={PROJECT_KIND_OPTIONS.findIndex((option) => option.kind === values.kind)}
          onSelect={(index) => patch({ kind: PROJECT_KIND_OPTIONS[index]!.kind })}
          onNext={onNext}
          onBack={onBack}
        />
      );
    case "model":
      return (
        <ModelStep
          value={values.modelId}
          onChange={(modelId) => patch({ modelId })}
          onNext={onNext}
          onBack={onBack}
        />
      );
    case "template":
      return (
        <RadioStep
          name="choose a template"
          helpText="the agent code scaffolded into the project"
          options={TEMPLATE_OPTIONS}
          selectedIndex={TEMPLATE_OPTIONS.findIndex(
            (option) => option.template === values.template,
          )}
          onSelect={(index) => patch({ template: TEMPLATE_OPTIONS[index]!.template })}
          onNext={onNext}
          onBack={onBack}
        />
      );
    case "memory":
      return (
        <RadioStep
          name="choose a memory configuration"
          helpText="how should the Strands agent remember conversations?"
          options={MEMORY_OPTIONS}
          selectedIndex={MEMORY_OPTIONS.findIndex((option) => option.memory === values.memory)}
          onSelect={(index) => patch({ memory: MEMORY_OPTIONS[index]!.memory })}
          onNext={onNext}
          onBack={onBack}
        />
      );
    case "review":
      return <ReviewStep values={values} onSubmit={onSubmit} onBack={onBack} />;
    default:
      return null;
  }
}

// NameStep validates against ProjectNameSchema — the schema the flag-driven
// path enforces — showing the schema's own messages inline as the user types.
function NameStep({
  value,
  onChange,
  onNext,
  onBack,
}: {
  value: string;
  onChange: (value: string) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const [submitted, setSubmitted] = useState(false);

  const validation = ProjectNameSchema.safeParse(value);
  const showError = !validation.success && (value !== "" || submitted);
  const errorMessage = showError ? validation.error.issues[0]?.message : undefined;

  useInput((_input, key) => {
    if (key.escape) {
      onBack();
      return;
    }
    if (key.return) {
      if (validation.success) onNext();
      else setSubmitted(true);
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <FormTextInput
        name="name your project"
        helpText="also the directory it is created in · letters and digits, starting with a letter"
        placeholder="MyAssistant"
        errorText=""
        value={value}
        onChange={(next) => {
          onChange(next);
          setSubmitted(false);
        }}
      />
      {errorMessage && <Text color={theme.colors.error}>{errorMessage}</Text>}
    </Box>
  );
}

// RadioStep is a single-choice step: the parent owns the selection, this owns
// the arrow/enter/esc handling around a FormRadioGroup.
function RadioStep({
  name,
  helpText,
  options,
  selectedIndex,
  onSelect,
  onNext,
  onBack,
}: {
  name: string;
  helpText: string;
  options: FormRadioOption[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  useInput((_input, key) => {
    if (key.escape) {
      onBack();
      return;
    }
    if (key.upArrow) {
      onSelect(Math.max(0, selectedIndex - 1));
      return;
    }
    if (key.downArrow) {
      onSelect(Math.min(options.length - 1, selectedIndex + 1));
      return;
    }
    if (key.return) onNext();
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <FormRadioGroup
        name={name}
        helpText={helpText}
        options={options}
        selectedIndex={selectedIndex}
      />
    </Box>
  );
}

function ModelStep({
  value,
  onChange,
  onNext,
  onBack,
}: {
  value: string;
  onChange: (value: string) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const [error, setError] = useState<string | null>(null);

  useInput((_input, key) => {
    if (key.escape) {
      onBack();
      return;
    }
    if (key.return) {
      if (value.trim() === "") {
        setError("enter a model id");
        return;
      }
      onNext();
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <FormTextInput
        name="model id"
        helpText="the model the harness runs on · every other setting uses defaults"
        placeholder={DEFAULT_HARNESS_MODEL.modelId}
        errorText=""
        value={value}
        onChange={(next) => {
          onChange(next);
          setError(null);
        }}
      />
      {error && <Text color={theme.colors.error}>{error}</Text>}
    </Box>
  );
}

function ReviewStep({
  values,
  onSubmit,
  onBack,
}: {
  values: CreateProjectFormValues;
  onSubmit: () => void;
  onBack: () => void;
}) {
  useInput((_input, key) => {
    if (key.escape) {
      onBack();
      return;
    }
    if (key.return) onSubmit();
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={theme.colors.text}>this project will be created</Text>
      <Box
        borderStyle="single"
        borderColor={theme.colors.border}
        borderLeft={false}
        borderRight={false}
        borderBottom={false}
      >
        <KeyValueTable items={summaryOf(values)} />
      </Box>
      <Text color={theme.colors.muted}>
        enter scaffolds the project, installs dependencies, and initializes git
      </Text>
    </Box>
  );
}

// ─── result panels ────────────────────────────────────────────────────────────

function EventLog({ events }: { events: string[] }) {
  return (
    <Box flexDirection="column">
      {events.map((message, index) => (
        <Text key={`${index}-${message}`} color={theme.colors.muted}>
          ✓ {message}
        </Text>
      ))}
    </Box>
  );
}

function SuccessPanel({ name, onContinue }: { name: string; onContinue: () => void }) {
  useInput((_input, key) => {
    if (key.return || key.escape) onContinue();
  });

  return (
    <Box flexDirection="column">
      <Text color={theme.colors.success} bold>
        ✔ project created in ./{name}
      </Text>
      <Text color={theme.colors.text}>next steps</Text>
      <Text color={theme.colors.primary}>{`  cd ${name}`}</Text>
      <Text color={theme.colors.primary}>{"  agentcore project deploy"}</Text>
      <Text color={theme.colors.muted}>enter exits</Text>
    </Box>
  );
}

// ErrorPanel reports the failure and tears the TUI down through the same
// exit(error) pattern the not-implemented project stubs use: exit(error)
// rejects the waitUntilExit() that renderTuiAt awaits, so the error takes the
// normal CLI path and the process exits nonzero.
function ErrorPanel({ error }: { error: Error }) {
  const { exit } = useApp();

  useEffect(() => {
    exit(error);
  }, [exit, error]);

  return <Text color={theme.colors.error}>✗ {error.message}</Text>;
}
