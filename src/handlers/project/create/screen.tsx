import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
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
  PROJECT_TEMPLATE_NAMES,
  RUNTIME_TEMPLATE_SHORTCUTS,
  resolveRuntimeTemplateShortcut,
  type TemplateName,
} from "../shortcuts";
import { HARNESS_DEFAULT_MODEL_IDS, resolveScaffoldHarnessInput } from "./index";
import { FormTextInput } from "../../../components/FormTextInput";
import { FormRadioGroup, type FormRadioOption } from "../../../components/FormRadioGroup";
import {
  ChoiceField,
  Step,
  Summary,
  TextField,
  Wizard,
  useKeyHints,
  useWizard,
  type Choice,
} from "../../../components/wizard";
import { darkTheme } from "../../../components/ui/_core.js";

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
    label: "bedrock",
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
    kind: "agent",
    model: emptyProjectModel(),
    template: DEFAULT_TEMPLATE,
  };
}

const PROJECT_KIND_CHOICES: Choice<ProjectKind>[] = [
  {
    value: "agent",
    label: "agent code",
    description: "generate runnable agent code from a template",
  },
  {
    value: "harness",
    label: "harness",
    description: "a managed agent configured by spec — no agent-loop code to maintain",
  },
];

const DEFAULT_TEMPLATE: TemplateName = "agent-python-strands";

const TEMPLATE_CHOICES: Choice<TemplateName>[] = PROJECT_TEMPLATE_NAMES.map((template) => ({
  value: template,
  label: template,
  description:
    template === EMPTY_TEMPLATE_NAME
      ? "an empty project with no runtime or harness"
      : RUNTIME_TEMPLATE_SHORTCUTS[template].description,
}));

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
  return MODEL_PROVIDERS.find((candidate) => candidate.provider === provider)!.label;
}

// ─── wizard ───────────────────────────────────────────────────────────────────

// ProjectCreateScreen is the interactive flow behind a bare `agentcore project
// create`: name → type → (model | template) → review, then the
// creation itself, streaming the ProjectManager's progress events. It drives
// core.projectManager.create with the same input the flag-driven handler
// builds, so both entry points scaffold identical projects — in the current
// working directory, npm install and git init included.
export function ProjectCreateScreen({ ctx, core }: ScreenProps) {
  const navigate = useNavigate();
  const [values, setValues] = useState<CreateProjectFormValues>(emptyCreateProjectForm);

  const patch = (update: Partial<CreateProjectFormValues>) =>
    setValues((current) => ({ ...current, ...update }));

  return (
    <Wizard
      breadcrumb={["agentcore", "project", "create"]}
      description="create a new AgentCore project"
      // Esc from the first step leaves the wizard for the project menu, the
      // same place RouterScreen's esc goes.
      onCancel={() => navigate("/agentcore/project")}
      onSubmit={() => {
        // Both of these throw before anything is written, so the wizard reports
        // them the way it reports a failed create — with the retry still on
        // offer, because nothing has to be cleaned up first.
        assertProjectPathFits(values.name, ctx.require(PlatformKey));
        return core.projectManager.create(buildCreateInput(values));
      }}
      onError="retry"
      runningLabel={`creating ${values.name}…`}
      successLabel={`project created in ./${values.name}`}
      successNextSteps={[`cd ${values.name}`, "agentcore project deploy"]}
      successHint="enter exits"
    >
      <Step name="name" question="name your project">
        {/* The label is the schema's own subject, so a blank name is refused
            with the message the flag-driven path prints for it. */}
        <TextField
          label="Project name"
          help="also the directory name · 1–23 letters and digits, starting with a letter"
          placeholder="MyAssistant"
          value={values.name}
          onChange={(name) => patch({ name })}
          schema={ProjectNameSchema}
          required
          live
        />
      </Step>

      <Step name="type" question="what should the project be built around?">
        <ChoiceField
          help="a project deploys either a managed harness or your own agent code"
          choices={PROJECT_KIND_CHOICES}
          value={values.kind}
          onChange={(kind) => patch({ kind })}
        />
      </Step>

      {values.kind === "harness" && (
        <Step name="model" question="choose a model">
          <ModelField value={values.model} onChange={(model) => patch({ model })} />
        </Step>
      )}

      {values.kind === "agent" && (
        <Step name="template" question="choose a template">
          <ChoiceField
            help="the agent code scaffolded into the project"
            choices={TEMPLATE_CHOICES}
            value={values.template}
            onChange={(template) => patch({ template })}
          />
        </Step>
      )}

      <Step name="review" question="this project will be created">
        <Summary items={summaryOf(values)} />
        <Box marginTop={1}>
          <Text color={theme.colors.muted}>
            enter scaffolds the project, installs dependencies, and initializes git
          </Text>
        </Box>
      </Step>
    </Wizard>
  );
}

// ─── the model step ───────────────────────────────────────────────────────────

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

// ModelField is a compound field: one useInput over a provider list and the
// per-provider inputs the choice reveals. The wizard shell has no notion of
// focus, so the two levels are managed here — the provider list until enter,
// then the fields, with esc stepping back out.
function ModelField({
  value,
  onChange,
}: {
  value: ProjectModelValues;
  onChange: (value: ProjectModelValues) => void;
}) {
  const { advance, back } = useWizard();
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

  useKeyHints([
    { key: "↑↓", label: "navigate" },
    { key: "enter", label: "continue" },
  ]);

  useInput((_input, key) => {
    if (focusedField === null) {
      if (key.escape) {
        back();
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
      advance();
    }
  });

  const options: FormRadioOption[] = MODEL_PROVIDERS.map(({ label, description }) => ({
    label,
    description,
  }));

  return (
    <Box flexDirection="column" flexGrow={1} minHeight={0}>
      <ScrollView
        ref={scrollRef}
        flexGrow={1}
        minHeight={0}
        onItemHeightChange={keepFocusedFieldVisible}
        onViewportSizeChange={keepFocusedFieldVisible}
      >
        <FormRadioGroup
          key="provider"
          helpText="the provider and model that will power the harness"
          options={options}
          focusedIndex={providerIndex}
          selectedIndex={focusedField !== null ? providerIndex : undefined}
        />
        {focusedField !== null &&
          fields.map((field, fieldIndex) => (
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
