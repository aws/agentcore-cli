import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { ScrollView, type ScrollViewRef } from "ink-scroll-view";
import { useNavigate } from "react-router";
import { ProjectNameSchema } from "../../../projectSchemas/project";
import type { HarnessModelProvider } from "../../../projectSchemas/harness";
import type { ScreenProps } from "../../types";
import { PlatformKey } from "../../../router";
import { assertProjectPathFits } from "./pathLimit";
import type { CreateProjectInput } from "../types";
import {
  EMPTY_TEMPLATE_NAME,
  resolveRuntimeTemplateShortcut,
  type TemplateName,
} from "../shortcuts";
import { HARNESS_DEFAULT_MODEL_IDS, resolveScaffoldHarnessInput } from "./index";
import { Layout } from "../../../components/Layout";
import { ErrorPanel } from "../../../components/ErrorPanel";
import { FormTextInput } from "../../../components/FormTextInput";
import { FormRadioGroup, type FormRadioOption } from "../../../components/FormRadioGroup";
import { KeyValueTable } from "../../../components/KeyValueTable";
import { Stepper, type Step } from "../../../components/ui/stepper";
import { Spinner } from "../../../components/ui/spinner";
import { TaskList, type Task } from "../../../components/ui/task-list";
import { Divider } from "../../../components/ui/divider";
import { driveProgress } from "../../../tui/progress";
import { darkTheme, glyphs } from "../../../components/ui/_core.js";

const theme = darkTheme;

// ─── form model ───────────────────────────────────────────────────────────────

// ProjectKind mirrors the headless dispatch: a project is created around either
// a harness (the default) or scaffolded runtime code.
type ProjectKind = "harness" | "agent";

interface ProjectModelConfig {
  modelId: string;
  apiKeyArn: string;
  apiBase: string;
}

interface ProjectModelValues {
  provider: HarnessModelProvider;
  configs: Record<HarnessModelProvider, ProjectModelConfig>;
}

interface CreateProjectFormValues {
  name: string;
  kind: ProjectKind;
  model: ProjectModelValues;
  template: TemplateName;
}

// defaultModelId is not declared here: the wizard and the flag path must offer
// the same default, so both read HARNESS_DEFAULT_MODEL_IDS.
const MODEL_PROVIDERS: {
  provider: HarnessModelProvider;
  label: string;
  description: string;
}[] = [
  {
    provider: "bedrock",
    label: "bedrock (recommended)",
    description: "an Amazon Bedrock model or inference profile",
  },
  {
    provider: "open_ai",
    label: "openai",
    description: "an OpenAI model using an API-key credential ARN",
  },
  {
    provider: "gemini",
    label: "gemini",
    description: "a Google Gemini model using an API-key credential ARN",
  },
  {
    provider: "lite_llm",
    label: "litellm",
    description: "a third-party provider through LiteLLM",
  },
];

function emptyProjectModel(): ProjectModelValues {
  return {
    provider: "bedrock",
    configs: Object.fromEntries(
      MODEL_PROVIDERS.map(({ provider }) => [
        provider,
        { modelId: HARNESS_DEFAULT_MODEL_IDS[provider], apiKeyArn: "", apiBase: "" },
      ]),
    ) as Record<HarnessModelProvider, ProjectModelConfig>,
  };
}

function emptyCreateProjectForm(): CreateProjectFormValues {
  return {
    name: "",
    kind: "harness",
    model: emptyProjectModel(),
    template: "agent-python-strands",
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
    label: "agent code",
    description: "generate runnable agent code from a template",
  },
];

const TEMPLATE_OPTIONS: {
  template: TemplateName;
  label: string;
  description: string;
}[] = [
  {
    template: "agent-python-langchain",
    label: "agent-python-langchain",
    description: "LangChain agent on Bedrock",
  },
  {
    template: "agent-python-minimal",
    label: "agent-python-minimal",
    description: "minimal Python agent on Bedrock, no framework",
  },
  {
    template: "agent-python-strands",
    label: "agent-python-strands (recommended)",
    description: "Strands agent on Bedrock with memory",
  },
  {
    template: "agent-python-strands-container",
    label: "agent-python-strands-container",
    description: "Strands agent on Bedrock with memory",
  },
  {
    template: "agent-typescript-strands",
    label: "agent-typescript-strands",
    description: "Strands agent on Bedrock with memory, in TypeScript",
  },
  {
    template: "a2a-python-strands",
    label: "a2a-python-strands",
    description: "Strands agent speaking the A2A protocol on Bedrock",
  },
  {
    template: "agui-python-strands",
    label: "agui-python-strands",
    description: "Strands agent speaking the AG-UI protocol on Bedrock",
  },
  {
    template: "mcp-python-fastmcp",
    label: "mcp-python-fastmcp",
    description: "MCP server exposing tools via FastMCP",
  },
  {
    template: EMPTY_TEMPLATE_NAME,
    label: "empty",
    description: "an empty project with no runtime or harness",
  },
];

function selectedModel(values: CreateProjectFormValues): ProjectModelConfig {
  return values.model.configs[values.model.provider];
}

// buildCreateInput translates the form through the same resolver as the
// flag-driven path, including its existing API-key ARN support.
export function buildCreateInput(values: CreateProjectFormValues): CreateProjectInput {
  if (values.kind === "harness") {
    const provider = values.model.provider;
    const config = selectedModel(values);
    return {
      name: values.name,
      skipInstall: false,
      skipGit: false,
      scaffoldHarnessInput: resolveScaffoldHarnessInput({
        name: values.name,
        "model-provider": provider,
        "model-id": config.modelId.trim(),
        "api-key-arn": config.apiKeyArn.trim() || undefined,
        "api-base":
          provider === "lite_llm" && config.apiBase.trim() !== ""
            ? config.apiBase.trim()
            : undefined,
      }),
    };
  }
  if (values.template === EMPTY_TEMPLATE_NAME) {
    return { name: values.name, skipInstall: false, skipGit: false };
  }
  return {
    name: values.name,
    skipInstall: false,
    skipGit: false,
    scaffoldRuntimeInput: resolveRuntimeTemplateShortcut(values.template),
  };
}

// summaryOf renders the review table: what will be created, and where.
function summaryOf(values: CreateProjectFormValues): Record<string, string> {
  const base = { project: values.name };
  if (values.kind === "harness") {
    const provider = values.model.provider;
    const config = selectedModel(values);
    return {
      ...base,
      type: "harness",
      provider: providerLabel(provider),
      model: config.modelId,
      ...(config.apiKeyArn && { "API key ARN": config.apiKeyArn }),
      ...(config.apiBase && { "API base URL": config.apiBase }),
      directory: `./${values.name}`,
    };
  }
  const type = values.template === EMPTY_TEMPLATE_NAME ? "empty project" : "agent code";
  return { ...base, type, template: values.template, directory: `./${values.name}` };
}

function providerLabel(provider: HarnessModelProvider): string {
  return MODEL_PROVIDERS.find((candidate) => candidate.provider === provider)!.label.replace(
    " (recommended)",
    "",
  );
}

// ─── wizard shell ─────────────────────────────────────────────────────────────

type WizardPhase =
  { kind: "form" } | { kind: "running" } | { kind: "success" } | { kind: "error"; error: Error };

// ProjectCreateScreen is the interactive flow behind a bare `agentcore project
// create`: name → type → (model | template) → review, then the
// creation itself, streaming the ProjectManager's progress events. It drives
// core.projectManager.create with the same input the flag-driven handler
// builds, so both entry points scaffold identical projects — in the current
// working directory, npm install and git init included.
export function ProjectCreateScreen({ ctx, core }: ScreenProps) {
  const navigate = useNavigate();
  const { exit } = useApp();

  const [values, setValues] = useState<CreateProjectFormValues>(emptyCreateProjectForm);
  const [stepIndex, setStepIndex] = useState(0);
  const [phase, setPhase] = useState<WizardPhase>({ kind: "form" });
  const [tasks, setTasks] = useState<Task[]>([]);

  // The step list is dynamic: the branch chosen on the type step decides
  // whether the model or the template question follows.
  const steps: Step[] = useMemo(() => {
    const branch: Step[] =
      values.kind === "harness"
        ? [{ key: "model", title: "model" }]
        : [{ key: "template", title: "template" }];
    return [
      { key: "name", title: "name" },
      { key: "type", title: "type" },
      ...branch,
      { key: "review", title: "review" },
    ];
  }, [values.kind]);

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
      assertProjectPathFits(values.name, ctx.require(PlatformKey));
      input = buildCreateInput(values);
    } catch (error) {
      setPhase({ kind: "error", error: toError(error) });
      return;
    }
    setPhase({ kind: "running" });
    setTasks([]);
    try {
      await driveProgress(core.projectManager.create(input), setTasks);
      setPhase({ kind: "success" });
    } catch (error) {
      setPhase({ kind: "error", error: toError(error) });
    }
  };

  return (
    <Layout
      breadcrumb={["agentcore", "project", "create"]}
      description="create a new AgentCore project"
      keyHints={hintsFor(stepKey, phase, tasks.length === 0)}
    >
      <Box flexDirection="column">
        {phase.kind === "form" && (
          <>
            <Box paddingX={1} flexShrink={0}>
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
            <TaskList tasks={tasks} />
            {phase.kind === "running" && tasks.length === 0 && (
              <Spinner label={`creating ${values.name}…`} />
            )}
            {phase.kind === "success" && (
              <SuccessPanel name={values.name} onContinue={() => exit()} />
            )}
            {phase.kind === "error" && (
              <ErrorPanel
                message={phase.error.message}
                onRetry={tasks.length === 0 ? submit : undefined}
                onBack={() => setPhase({ kind: "form" })}
              />
            )}
          </Box>
        )}
      </Box>
    </Layout>
  );
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

// A retry is only offered while nothing has been written yet: once a step has
// run, the scaffolded directory exists and re-submitting would fail on it.
function hintsFor(
  stepKey: string,
  phase: WizardPhase,
  retryable: boolean,
): { key: string; label: string }[] {
  if (phase.kind === "running") return [{ key: "ctrl+c", label: "quit" }];
  if (phase.kind === "success") return [{ key: "enter", label: "exit" }];
  if (phase.kind === "error")
    return [
      ...(retryable ? [{ key: "r", label: "retry" }] : []),
      { key: "esc", label: "back" },
      { key: "ctrl+c", label: "quit" },
    ];
  const base = [
    { key: "esc", label: "back" },
    { key: "ctrl+c", label: "quit" },
  ];
  switch (stepKey) {
    case "name":
      return [{ key: "enter", label: "continue" }, ...base];
    case "model":
      return [{ key: "↑↓", label: "navigate" }, { key: "enter", label: "continue" }, ...base];
    case "type":
    case "template":
    case "memory":
      return [{ key: "↑↓", label: "navigate" }, { key: "enter", label: "continue" }, ...base];
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
          focusedIndex={PROJECT_KIND_OPTIONS.findIndex((option) => option.kind === values.kind)}
          onSelect={(index) => patch({ kind: PROJECT_KIND_OPTIONS[index]!.kind })}
          onNext={onNext}
          onBack={onBack}
        />
      );
    case "model":
      return (
        <ModelStep
          value={values.model}
          onChange={(model) => patch({ model })}
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
          focusedIndex={TEMPLATE_OPTIONS.findIndex((option) => option.template === values.template)}
          onSelect={(index) => patch({ template: TEMPLATE_OPTIONS[index]!.template })}
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
        helpText="also the directory name · 1–23 letters and digits, starting with a letter"
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
  focusedIndex,
  onSelect,
  onNext,
  onBack,
}: {
  name: string;
  helpText: string;
  options: FormRadioOption[];
  focusedIndex: number;
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
      onSelect(Math.max(0, focusedIndex - 1));
      return;
    }
    if (key.downArrow) {
      onSelect(Math.min(options.length - 1, focusedIndex + 1));
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
        focusedIndex={focusedIndex}
      />
    </Box>
  );
}

type ModelFieldKey = keyof ProjectModelConfig;

interface ModelField {
  key: ModelFieldKey;
  name: string;
  helpText: string;
  placeholder: string;
  required: boolean;
  requiredError: string;
}

function modelFields(provider: HarnessModelProvider): ModelField[] {
  const fields: ModelField[] = [
    {
      key: "modelId",
      name: "model ID",
      helpText:
        provider === "bedrock"
          ? "a Bedrock model or inference profile ID"
          : `the ${providerLabel(provider)} model to use`,
      placeholder: HARNESS_DEFAULT_MODEL_IDS[provider],
      required: true,
      requiredError: `enter a model ID for ${providerLabel(provider)}`,
    },
  ];

  if (provider !== "bedrock") {
    fields.push({
      key: "apiKeyArn",
      name: "API key ARN",
      helpText:
        provider === "lite_llm"
          ? "optional · an AgentCore Identity API-key credential provider ARN"
          : "an AgentCore Identity API-key credential provider ARN",
      placeholder:
        provider === "lite_llm"
          ? "optional"
          : "arn:aws:bedrock-agentcore:…:token-vault/…/apikeycredentialprovider/…",
      required: provider !== "lite_llm",
      requiredError: `enter an API key ARN for ${providerLabel(provider)}`,
    });
  }

  if (provider === "lite_llm") {
    fields.push({
      key: "apiBase",
      name: "API base URL",
      helpText: "optional · the provider API endpoint",
      placeholder: "https://…",
      required: false,
      requiredError: "",
    });
  }

  return fields;
}

function ModelStep({
  value,
  onChange,
  onNext,
  onBack,
}: {
  value: ProjectModelValues;
  onChange: (value: ProjectModelValues) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const providerIndex = MODEL_PROVIDERS.findIndex((option) => option.provider === value.provider);
  const fields = modelFields(value.provider);
  const config = value.configs[value.provider];
  const [focusedField, setFocusedField] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<ScrollViewRef>(null);

  const keepFocusedFieldVisible = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    if (focusedField === null) {
      scroll.scrollToTop();
      return;
    }

    const position = scroll.getItemPosition(focusedField + 1);
    if (!position) return;
    const viewportHeight = scroll.getViewportHeight();
    const offset = scroll.getScrollOffset();
    const bottom = position.top + position.height;
    if (position.top < offset) scroll.scrollTo(position.top);
    else if (bottom > offset + viewportHeight) scroll.scrollTo(bottom - viewportHeight);
  }, [focusedField]);

  useEffect(() => {
    keepFocusedFieldVisible();
  }, [keepFocusedFieldVisible, value.provider, error]);

  useInput((_input, key) => {
    if (focusedField === null) {
      if (key.escape) {
        onBack();
        return;
      }
      if (key.upArrow || key.downArrow) {
        const nextIndex = key.upArrow
          ? Math.max(0, providerIndex - 1)
          : Math.min(MODEL_PROVIDERS.length - 1, providerIndex + 1);
        onChange({ ...value, provider: MODEL_PROVIDERS[nextIndex]!.provider });
        setError(null);
        return;
      }
      if (key.return) setFocusedField(0);
      return;
    }

    if (key.escape) {
      setFocusedField(null);
      setError(null);
      return;
    }
    if (key.upArrow) {
      setFocusedField(focusedField === 0 ? null : focusedField - 1);
      setError(null);
      return;
    }
    if (key.downArrow) {
      setFocusedField(Math.min(fields.length - 1, focusedField + 1));
      setError(null);
      return;
    }
    if (key.return) {
      const field = fields[focusedField]!;
      if (field.required && config[field.key].trim() === "") {
        setError(field.requiredError);
        return;
      }
      if (focusedField < fields.length - 1) {
        setFocusedField(focusedField + 1);
        return;
      }
      const missing = fields.findIndex(
        (candidate) => candidate.required && config[candidate.key].trim() === "",
      );
      if (missing >= 0) {
        setFocusedField(missing);
        setError(fields[missing]!.requiredError);
        return;
      }
      onNext();
    }
  });

  const options: FormRadioOption[] = MODEL_PROVIDERS.map(({ label, description }) => ({
    label,
    description,
  }));

  return (
    <Box flexDirection="column" paddingX={1} flexGrow={1} minHeight={0}>
      <ScrollView
        ref={scrollRef}
        flexGrow={1}
        minHeight={0}
        onItemHeightChange={keepFocusedFieldVisible}
        onViewportSizeChange={keepFocusedFieldVisible}
      >
        <FormRadioGroup
          key="provider"
          name="choose a model"
          helpText="the provider and model that will power the harness"
          options={options}
          focusedIndex={providerIndex}
        />
        {fields.map((field, fieldIndex) => (
          <FormTextInput
            key={`${value.provider}.${field.key}`}
            name={field.name}
            helpText={field.helpText}
            placeholder={field.placeholder}
            errorText=""
            value={config[field.key]}
            onChange={(next) => {
              onChange({
                ...value,
                configs: {
                  ...value.configs,
                  [value.provider]: { ...config, [field.key]: next },
                },
              });
              setError(null);
            }}
            focused={focusedField === fieldIndex}
          />
        ))}
        {error && (
          <Text key="error" color={theme.colors.error}>
            {error}
          </Text>
        )}
      </ScrollView>
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
      <Box marginTop={1}>
        <Text color={theme.colors.muted}>
          enter scaffolds the project, installs dependencies, and initializes git
        </Text>
      </Box>
    </Box>
  );
}

// ─── result panels ────────────────────────────────────────────────────────────

function SuccessPanel({ name, onContinue }: { name: string; onContinue: () => void }) {
  useInput((_input, key) => {
    if (key.return || key.escape) onContinue();
  });

  return (
    <Box flexDirection="column" gap={1}>
      <Text color={theme.colors.success} bold>
        {glyphs.check} project created in ./{name}
      </Text>
      <Box flexDirection="column">
        <Text color={theme.colors.text}>next steps</Text>
        <Text color={theme.colors.primary}>{`  cd ${name}`}</Text>
        <Text color={theme.colors.primary}>{"  agentcore project deploy"}</Text>
      </Box>
      <Text color={theme.colors.muted}>enter exits</Text>
    </Box>
  );
}
