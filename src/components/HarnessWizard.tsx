import { useMemo, useState } from "react";
import { Box, Text, useInput, useWindowSize } from "ink";
import { useNavigate } from "react-router";
import type {
  Harness,
  HarnessMemoryConfiguration,
  HarnessTool,
  UpdateHarnessRequest,
} from "@aws-sdk/client-bedrock-agentcore-control";
import type { CreateHarnessInput } from "../handlers/harness/types";
import type { ScreenProps } from "../handlers/types";
import { coreOptsFromCtx } from "../handlers/utils";
import { Layout } from "./Layout";
import { ErrorPanel } from "./ErrorPanel";
import { FormTextInput } from "./FormTextInput";
import { FormRadioGroup, type FormRadioOption } from "./FormRadioGroup";
import { FormCheckboxMultiSelect, type FormCheckboxOption } from "./FormCheckboxMultiSelect";
import { FormTextArea } from "./FormTextArea";
import { Stepper, type Step } from "./ui/stepper";
import { Spinner } from "./ui/spinner";
import { CodeBlock } from "./ui/code-block";
import { ScrollView } from "ink-scroll-view";
import { darkTheme, glyphs } from "./ui/_core.js";
import { Divider } from "./ui/divider/Divider.js";
import { KeyValueTable } from "./KeyValueTable.js";

const theme = darkTheme;

// ─── form model ───────────────────────────────────────────────────────────────

export type MemoryKind = "managed" | "byo" | "disabled";

// ModelKind selects the provider member of the API's HarnessModelConfiguration
// union; "default" means "don't send a model" (service default on create, keep
// the current one on update).
export type ModelKind = "default" | "bedrock" | "gemini" | "openai" | "litellm";

// HarnessFormValues is the flat, editable shape the wizard collects. It is
// deliberately simpler than the API request; toCreateInput / toUpdateRequest
// translate it (and fromHarness translates back for the update flow).
export interface HarnessFormValues {
  name: string;
  // model holds the fields of every provider flattened together; only the ones
  // the selected kind needs are shown, validated, and sent.
  model: { kind: ModelKind; modelId: string; apiKeyArn: string; apiBase: string };
  memory: { kind: MemoryKind; arn: string };
  tools: {
    browser: boolean;
    gatewayArn: string;
    mcpUrl: string;
  };
  systemPrompt: string;
  // passthroughTools carries tools the form doesn't model (inline functions,
  // code interpreters, additional MCP servers, ...) so an update never
  // silently drops them.
  passthroughTools: HarnessTool[];
}

export function emptyHarnessForm(): HarnessFormValues {
  return {
    name: "",
    model: { kind: "default", modelId: "", apiKeyArn: "", apiBase: "" },
    memory: { kind: "managed", arn: "" },
    tools: { browser: true, gatewayArn: "", mcpUrl: "" },
    systemPrompt: "",
    passthroughTools: [],
  };
}

// fromHarness maps an existing harness into form values so the update flow
// starts from the current configuration.
export function fromHarness(harness: Harness): HarnessFormValues {
  const values = emptyHarnessForm();
  values.name = harness.harnessName ?? "";

  const memory = harness.memory;
  if (memory?.disabled) values.memory = { kind: "disabled", arn: "" };
  else if (memory?.agentCoreMemoryConfiguration) {
    values.memory = { kind: "byo", arn: memory.agentCoreMemoryConfiguration.arn ?? "" };
  } else {
    values.memory = { kind: "managed", arn: "" };
  }

  for (const tool of harness.tools ?? []) {
    if (tool.config?.agentCoreBrowser) values.tools.browser = true;
    else if (tool.config?.agentCoreGateway && values.tools.gatewayArn === "") {
      values.tools.gatewayArn = tool.config.agentCoreGateway.gatewayArn ?? "";
    } else if (tool.config?.remoteMcp && values.tools.mcpUrl === "") {
      values.tools.mcpUrl = tool.config.remoteMcp.url ?? "";
    } else {
      values.passthroughTools.push(tool);
    }
  }

  values.systemPrompt = (harness.systemPrompt ?? [])
    .map((block) => block.text ?? "")
    .filter((text) => text !== "")
    .join("\n");

  const model = harness.model;
  if (model?.bedrockModelConfig) {
    values.model = {
      kind: "bedrock",
      modelId: model.bedrockModelConfig.modelId ?? "",
      apiKeyArn: "",
      apiBase: "",
    };
  } else if (model?.geminiModelConfig) {
    values.model = {
      kind: "gemini",
      modelId: model.geminiModelConfig.modelId ?? "",
      apiKeyArn: model.geminiModelConfig.apiKeyArn ?? "",
      apiBase: "",
    };
  } else if (model?.openAiModelConfig) {
    values.model = {
      kind: "openai",
      modelId: model.openAiModelConfig.modelId ?? "",
      apiKeyArn: model.openAiModelConfig.apiKeyArn ?? "",
      apiBase: "",
    };
  } else if (model?.liteLlmModelConfig) {
    values.model = {
      kind: "litellm",
      modelId: model.liteLlmModelConfig.modelId ?? "",
      apiKeyArn: model.liteLlmModelConfig.apiKeyArn ?? "",
      apiBase: model.liteLlmModelConfig.apiBase ?? "",
    };
  }
  return values;
}

// ─── form → request translation ───────────────────────────────────────────────

function toMemoryConfiguration(values: HarnessFormValues): HarnessMemoryConfiguration {
  switch (values.memory.kind) {
    case "managed":
      return { managedMemoryConfiguration: {} };
    case "byo":
      return { agentCoreMemoryConfiguration: { arn: values.memory.arn } };
    case "disabled":
      return { disabled: {} };
  }
}

// toModelConfiguration builds the provider member of the model union, or
// undefined for "default" (service default on create, keep current on update).
function toModelConfiguration(values: HarnessFormValues): CreateHarnessInput["model"] {
  const model = values.model;
  switch (model.kind) {
    case "default":
      return undefined;
    case "bedrock":
      return { bedrockModelConfig: { modelId: model.modelId } };
    case "gemini":
      return { geminiModelConfig: { modelId: model.modelId, apiKeyArn: model.apiKeyArn } };
    case "openai":
      return { openAiModelConfig: { modelId: model.modelId, apiKeyArn: model.apiKeyArn } };
    case "litellm":
      return {
        liteLlmModelConfig: {
          modelId: model.modelId,
          apiKeyArn: model.apiKeyArn || undefined,
          apiBase: model.apiBase || undefined,
        },
      };
  }
}

function toTools(values: HarnessFormValues): HarnessTool[] {
  const tools: HarnessTool[] = [];
  if (values.tools.browser) {
    tools.push({ type: "agentcore_browser", config: { agentCoreBrowser: {} } });
  }
  if (values.tools.gatewayArn !== "") {
    tools.push({
      type: "agentcore_gateway",
      config: { agentCoreGateway: { gatewayArn: values.tools.gatewayArn } },
    });
  }
  if (values.tools.mcpUrl !== "") {
    tools.push({ type: "remote_mcp", config: { remoteMcp: { url: values.tools.mcpUrl } } });
  }
  return [...tools, ...values.passthroughTools];
}

// toCreateInput translates the form into the CreateHarness request. Fields left
// at their defaults are omitted so the service applies its own defaults.
export function toCreateInput(values: HarnessFormValues): CreateHarnessInput {
  const tools = toTools(values);
  return {
    harnessName: values.name,
    memory: toMemoryConfiguration(values),
    tools: tools.length > 0 ? tools : undefined,
    systemPrompt: values.systemPrompt !== "" ? [{ text: values.systemPrompt }] : undefined,
    model: toModelConfiguration(values),
  };
}

// toUpdateRequest translates the form into an UpdateHarness request, including
// only the fields whose form value changed — UpdateHarness has PATCH semantics,
// and an untouched field should stay untouched on the service side too.
export function toUpdateRequest(
  harnessId: string,
  values: HarnessFormValues,
  initial: HarnessFormValues,
): UpdateHarnessRequest {
  const request: UpdateHarnessRequest = { harnessId };

  const memoryChanged =
    values.memory.kind !== initial.memory.kind || values.memory.arn !== initial.memory.arn;
  if (memoryChanged) request.memory = { optionalValue: toMemoryConfiguration(values) };

  const modelChanged = JSON.stringify(values.model) !== JSON.stringify(initial.model);
  if (modelChanged && values.model.kind !== "default") {
    request.model = toModelConfiguration(values);
  }

  if (JSON.stringify(values.tools) !== JSON.stringify(initial.tools)) {
    request.tools = toTools(values);
  }

  if (values.systemPrompt !== initial.systemPrompt && values.systemPrompt !== "") {
    request.systemPrompt = [{ text: values.systemPrompt }];
  }

  return request;
}

// ─── wizard shell ─────────────────────────────────────────────────────────────

type WizardPhase =
  | { kind: "form" }
  | { kind: "submitting" }
  | { kind: "success"; harnessId: string; version?: string; status?: string; arn?: string }
  | { kind: "error"; message: string };

export interface HarnessWizardProps extends ScreenProps {
  mode: "create" | "update";
  breadcrumb: string[];
  // description is the optional subtitle shown after the breadcrumb.
  description?: string;
  // harnessId is the update target (update mode only).
  harnessId?: string;
  // initial seeds the form (update mode: the current configuration).
  initial?: HarnessFormValues;
  // onDone is called after a successful submit is acknowledged.
  onDone: (harnessId: string) => void;
}

const NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/;

// HarnessWizard is the interactive step flow behind `harness create` and
// `harness update`: name → model → memory → tools → prompt → review, then
// submit. Update mode skips the name step (harnesses cannot be renamed) and
// submits only what changed.
export function HarnessWizard({
  ctx,
  core,
  mode,
  breadcrumb,
  description,
  harnessId,
  initial,
  onDone,
}: HarnessWizardProps) {
  const navigate = useNavigate();
  const opts = coreOptsFromCtx(ctx);

  const steps: Step[] = useMemo(() => {
    const all: Step[] = [
      { key: "name", title: "name" },
      { key: "model", title: "model" },
      { key: "memory", title: "memory" },
      { key: "tools", title: "tools" },
      { key: "prompt", title: "prompt" },
      { key: "review", title: "review" },
    ];
    return mode === "create" ? all : all.filter((step) => step.key !== "name");
  }, [mode]);

  const [initialValues] = useState<HarnessFormValues>(() => initial ?? emptyHarnessForm());
  const [values, setValues] = useState<HarnessFormValues>(initialValues);
  const [stepIndex, setStepIndex] = useState(0);
  const [phase, setPhase] = useState<WizardPhase>({ kind: "form" });

  const stepKey = steps[stepIndex]!.key;
  const patch = (update: Partial<HarnessFormValues>) =>
    setValues((current) => ({ ...current, ...update }));

  const next = () => setStepIndex((i) => Math.min(steps.length - 1, i + 1));
  const back = () => {
    if (stepIndex === 0) navigate(-1);
    else setStepIndex((i) => i - 1);
  };

  const request = useMemo(
    () =>
      mode === "create"
        ? toCreateInput(values)
        : toUpdateRequest(harnessId ?? "", values, initialValues),
    [mode, values, harnessId, initialValues],
  );

  const submit = async () => {
    setPhase({ kind: "submitting" });
    try {
      if (mode === "create") {
        const response = await core.harness.createHarness(toCreateInput(values), opts);
        setPhase({
          kind: "success",
          harnessId: response.harness?.harnessId ?? "",
          version: response.harness?.harnessVersion,
          status: response.harness?.status,
          arn: response.harness?.arn,
        });
      } else {
        const response = await core.harness.updateHarness(
          toUpdateRequest(harnessId!, values, initialValues),
          opts,
        );
        setPhase({
          kind: "success",
          harnessId: response.harness?.harnessId ?? harnessId!,
          version: response.harness?.harnessVersion,
          status: response.harness?.status,
          arn: response.harness?.arn,
        });
      }
    } catch (error) {
      setPhase({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const verb = mode === "create" ? "create" : "update";
  const keyHints = hintsFor(stepKey, phase, verb);

  return (
    <Layout breadcrumb={breadcrumb} description={description} keyHints={keyHints}>
      <Box flexDirection="column">
        <Box paddingX={1}>
          <Stepper
            steps={steps}
            currentStep={stepKey}
            completedSteps={steps.slice(0, stepIndex).map((step) => step.key)}
          />
        </Box>

        <Divider />

        {phase.kind === "form" && (
          <WizardStep
            stepKey={stepKey}
            mode={mode}
            values={values}
            patch={patch}
            request={request}
            onNext={next}
            onBack={back}
            onSubmit={submit}
          />
        )}
        {phase.kind === "submitting" && (
          <Spinner
            label={
              mode === "create"
                ? "creating harness… provisioning the execution role can take a moment"
                : "updating harness…"
            }
          />
        )}
        {phase.kind === "success" && (
          <SuccessPanel
            mode={mode}
            harnessId={phase.harnessId}
            version={phase.version}
            status={phase.status}
            arn={phase.arn}
            onContinue={() => onDone(phase.harnessId)}
          />
        )}
        {phase.kind === "error" && (
          <ErrorPanel message={phase.message} onBack={() => setPhase({ kind: "form" })} />
        )}
      </Box>
    </Layout>
  );
}

function hintsFor(
  stepKey: string,
  phase: WizardPhase,
  verb: string,
): { key: string; label: string }[] {
  if (phase.kind === "submitting") return [{ key: "ctrl+c", label: "quit" }];
  if (phase.kind === "success") return [{ key: "enter", label: "continue" }];
  if (phase.kind === "error")
    return [
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
    case "memory":
      return [{ key: "↑↓", label: "navigate" }, { key: "enter", label: "continue" }, ...base];
    case "tools":
      return [
        { key: "↑↓", label: "navigate" },
        { key: "space", label: "toggle" },
        { key: "enter", label: "continue" },
        ...base,
      ];
    case "prompt":
      return [{ key: "enter", label: "newline" }, { key: "ctrl+d", label: "continue" }, ...base];
    case "review":
      return [{ key: "enter", label: verb }, { key: "↑↓", label: "scroll" }, ...base];
    default:
      return base;
  }
}

interface WizardStepProps {
  stepKey: string;
  mode: "create" | "update";
  values: HarnessFormValues;
  patch: (update: Partial<HarnessFormValues>) => void;
  request: unknown;
  onNext: () => void;
  onBack: () => void;
  onSubmit: () => void;
}

function WizardStep({
  stepKey,
  mode,
  values,
  patch,
  request,
  onNext,
  onBack,
  onSubmit,
}: WizardStepProps) {
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
    case "model":
      return (
        <ModelStep
          mode={mode}
          value={values.model}
          onChange={(model) => patch({ model })}
          onNext={onNext}
          onBack={onBack}
        />
      );
    case "memory":
      return (
        <MemoryStep
          value={values.memory}
          onChange={(memory) => patch({ memory })}
          onNext={onNext}
          onBack={onBack}
        />
      );
    case "tools":
      return (
        <ToolsStep
          value={values.tools}
          onChange={(tools) => patch({ tools })}
          onNext={onNext}
          onBack={onBack}
        />
      );
    case "prompt":
      return (
        <PromptStep
          value={values.systemPrompt}
          onChange={(systemPrompt) => patch({ systemPrompt })}
          onNext={onNext}
          onBack={onBack}
        />
      );
    case "review":
      return <ReviewStep mode={mode} request={request} onSubmit={onSubmit} onBack={onBack} />;
    default:
      return null;
  }
}

// ─── step: name ───────────────────────────────────────────────────────────────

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
  useInput((_input, key) => {
    if (key.escape) {
      onBack();
      return;
    }
    if (key.return && NAME_PATTERN.test(value)) onNext();
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <FormTextInput
        name="the name of your harness"
        helpText="letters, numbers, underscores; must start with a letter"
        errorText="must start with a letter; letters, numbers, and underscores only"
        placeholder="my_agent"
        value={value}
        onChange={onChange}
        pattern={NAME_PATTERN}
      />
    </Box>
  );
}

// ─── step: model ──────────────────────────────────────────────────────────────

type ModelFieldKey = "modelId" | "apiKeyArn" | "apiBase";

interface ModelField {
  key: ModelFieldKey;
  name: string;
  helpText: string;
  placeholder: string;
  // required fields block continuing while empty; optional ones are omitted
  // from the request when left empty.
  required: boolean;
  requiredError: string;
}

// MODEL_PROVIDERS mirrors the API's HarnessModelConfiguration union: one row
// per provider, plus the "default" opt-out, each declaring the fields the
// provider needs.
const MODEL_PROVIDERS: {
  kind: ModelKind;
  label: string;
  description: string;
  fields: ModelField[];
}[] = [
  {
    kind: "default",
    label: "service default",
    description: "let the service choose the model",
    fields: [],
  },
  {
    kind: "bedrock",
    label: "bedrock",
    description: "an Amazon Bedrock model or inference profile",
    fields: [
      {
        key: "modelId",
        name: "model ID",
        helpText: "a Bedrock model or inference profile ID",
        placeholder: "us.anthropic.claude-sonnet-4-6",
        required: true,
        requiredError: "enter a Bedrock model or inference profile ID",
      },
    ],
  },
  {
    kind: "gemini",
    label: "gemini",
    description: "a Google Gemini model using an API-key credential ARN",
    fields: [
      {
        key: "modelId",
        name: "model ID",
        helpText: "the Gemini model to use",
        placeholder: "gemini-2.5-pro",
        required: true,
        requiredError: "enter a Gemini model ID",
      },
      {
        key: "apiKeyArn",
        name: "API key ARN",
        helpText: "an AgentCore Identity API-key credential provider ARN",
        placeholder: "arn:aws:bedrock-agentcore:…:token-vault/…",
        required: true,
        requiredError: "enter an API-key credential provider ARN",
      },
    ],
  },
  {
    kind: "openai",
    label: "openai",
    description: "an OpenAI model using an API-key credential ARN",
    fields: [
      {
        key: "modelId",
        name: "model ID",
        helpText: "the OpenAI model to use",
        placeholder: "gpt-5",
        required: true,
        requiredError: "enter an OpenAI model ID",
      },
      {
        key: "apiKeyArn",
        name: "API key ARN",
        helpText: "an AgentCore Identity API-key credential provider ARN",
        placeholder: "arn:aws:bedrock-agentcore:…:token-vault/…",
        required: true,
        requiredError: "enter an API-key credential provider ARN",
      },
    ],
  },
  {
    kind: "litellm",
    label: "litellm",
    description: "a third-party provider through LiteLLM",
    fields: [
      {
        key: "modelId",
        name: "model ID",
        helpText: "the LiteLLM model identifier (provider/model)",
        placeholder: "anthropic/claude-3-sonnet",
        required: true,
        requiredError: "enter a LiteLLM model identifier",
      },
      {
        key: "apiKeyArn",
        name: "API key ARN",
        helpText: "optional · an AgentCore Identity API-key credential provider ARN",
        placeholder: "arn:aws:bedrock-agentcore:…:token-vault/…",
        required: false,
        requiredError: "",
      },
      {
        key: "apiBase",
        name: "API base URL",
        helpText: "optional · the provider API endpoint",
        placeholder: "https://…",
        required: false,
        requiredError: "",
      },
    ],
  },
];

function ModelStep({
  mode,
  value,
  onChange,
  onNext,
  onBack,
}: {
  mode: "create" | "update";
  value: HarnessFormValues["model"];
  onChange: (value: HarnessFormValues["model"]) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const index = MODEL_PROVIDERS.findIndex((provider) => provider.kind === value.kind);
  const provider = MODEL_PROVIDERS[index]!;
  // focusedField indexes into provider.fields while editing; null while the
  // radio list has focus.
  const [focusedField, setFocusedField] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useInput((_input, key) => {
    if (focusedField === null) {
      if (key.escape) {
        onBack();
        return;
      }
      if (key.upArrow) {
        onChange({ ...value, kind: MODEL_PROVIDERS[Math.max(0, index - 1)]!.kind });
        setError(null);
        return;
      }
      if (key.downArrow) {
        const next = MODEL_PROVIDERS[Math.min(MODEL_PROVIDERS.length - 1, index + 1)]!;
        onChange({ ...value, kind: next.kind });
        setError(null);
        return;
      }
      if (key.return) {
        if (provider.fields.length === 0) onNext();
        else setFocusedField(0);
      }
      return;
    }

    // A field is focused; its TextInput owns text editing.
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
      setFocusedField(Math.min(provider.fields.length - 1, focusedField + 1));
      setError(null);
      return;
    }
    if (key.return) {
      const field = provider.fields[focusedField]!;
      if (field.required && value[field.key].trim() === "") {
        setError(field.requiredError);
        return;
      }
      if (focusedField < provider.fields.length - 1) {
        setFocusedField(focusedField + 1);
        return;
      }
      // Last field: every required field must be filled before moving on.
      const missing = provider.fields.findIndex(
        (other) => other.required && value[other.key].trim() === "",
      );
      if (missing >= 0) {
        setFocusedField(missing);
        setError(provider.fields[missing]!.requiredError);
        return;
      }
      onNext();
    }
  });

  const rows: FormRadioOption[] = MODEL_PROVIDERS.map((row) =>
    row.kind === "default" && mode === "update"
      ? { label: "keep current", description: "leave the model configuration untouched" }
      : { label: row.label, description: row.description },
  );

  return (
    <Box flexDirection="column" paddingX={1}>
      <FormRadioGroup
        name="choose a model"
        helpText="the provider and model that will power the harness"
        options={rows}
        focusedIndex={index}
        selectedIndex={focusedField !== null ? index : undefined}
      />
      {focusedField !== null &&
        provider.fields.map((field, i) => (
          <FormTextInput
            key={`${provider.kind}.${field.key}`}
            name={field.name}
            helpText={field.helpText}
            placeholder={field.placeholder}
            errorText=""
            value={value[field.key]}
            onChange={(next) => {
              onChange({ ...value, [field.key]: next });
              setError(null);
            }}
            focused={focusedField === i}
          />
        ))}
      {error && <Text color={theme.colors.error}>{error}</Text>}
      {index !== 0 && (
        <Text color={theme.colors.info}>
          use the command line to pass additional params, e.g.,{" "}
          <Text color={theme.colors.primary}>agentcore harness create --name …</Text>
        </Text>
      )}
    </Box>
  );
}

// ─── step: memory ─────────────────────────────────────────────────────────────

const MEMORY_OPTIONS: { kind: MemoryKind; label: string; description: string }[] = [
  {
    kind: "managed",
    label: "managed",
    description: "AgentCore creates and manages memory for you",
  },
  {
    kind: "byo",
    label: "bring your own",
    description: "use an existing AgentCore Memory",
  },
  { kind: "disabled", label: "disabled", description: "no memory across sessions" },
];

function MemoryStep({
  value,
  onChange,
  onNext,
  onBack,
}: {
  value: HarnessFormValues["memory"];
  onChange: (value: HarnessFormValues["memory"]) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const index = MEMORY_OPTIONS.findIndex((option) => option.kind === value.kind);
  // editing is true while the byo arn field has focus; the radio list has
  // focus otherwise.
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useInput((_input, key) => {
    if (!editing) {
      if (key.escape) {
        onBack();
        return;
      }
      if (key.upArrow) {
        onChange({ ...value, kind: MEMORY_OPTIONS[Math.max(0, index - 1)]!.kind });
        setError(null);
        return;
      }
      if (key.downArrow) {
        const next = MEMORY_OPTIONS[Math.min(MEMORY_OPTIONS.length - 1, index + 1)]!;
        onChange({ ...value, kind: next.kind });
        setError(null);
        return;
      }
      if (key.return) {
        if (value.kind === "byo") setEditing(true);
        else onNext();
      }
      return;
    }

    // The arn field is focused; its TextInput owns text editing.
    if (key.escape || key.upArrow) {
      setEditing(false);
      setError(null);
      return;
    }
    if (key.return) {
      if (value.arn.trim() === "") {
        setError("enter the ARN of an existing AgentCore Memory");
        return;
      }
      onNext();
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <FormRadioGroup
        name="choose a memory configuration"
        helpText="how should the harness remember conversations?"
        options={MEMORY_OPTIONS}
        focusedIndex={index}
        selectedIndex={editing ? index : undefined}
      />
      {editing && value.kind === "byo" && (
        <FormTextInput
          name="Memory ARN"
          helpText="the ARN of an existing AgentCore Memory"
          placeholder="arn:aws:bedrock-agentcore:…:memory/…"
          errorText=""
          value={value.arn}
          onChange={(arn) => {
            onChange({ ...value, arn });
            setError(null);
          }}
          focused={editing}
        />
      )}
      {error && <Text color={theme.colors.error}>{error}</Text>}
    </Box>
  );
}

// ─── step: tools ──────────────────────────────────────────────────────────────

type ToolRowKey = "browser" | "gateway" | "mcp";

// TOOL_ROWS lists the tools the form models; gateway and mcp declare the field
// their configuration needs.
const TOOL_ROWS: {
  key: ToolRowKey;
  label: string;
  description: string;
  field?: {
    valueKey: "gatewayArn" | "mcpUrl";
    name: string;
    helpText: string;
    placeholder: string;
  };
}[] = [
  { key: "browser", label: "browser", description: "browse the web with AgentCore Browser" },
  {
    key: "gateway",
    label: "gateway",
    description: "call tools through an AgentCore Gateway",
    field: {
      valueKey: "gatewayArn",
      name: "Gateway ARN",
      helpText: "the ARN of the AgentCore Gateway to call tools through",
      placeholder: "arn:aws:bedrock-agentcore:…:gateway/…",
    },
  },
  {
    key: "mcp",
    label: "MCP server",
    description: "connect to a remote MCP server",
    field: {
      valueKey: "mcpUrl",
      name: "server URL",
      helpText: "the URL of the remote MCP server",
      placeholder: "https://…",
    },
  },
];

function ToolsStep({
  value,
  onChange,
  onNext,
  onBack,
}: {
  value: HarnessFormValues["tools"];
  onChange: (value: HarnessFormValues["tools"]) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const [cursor, setCursor] = useState(0);
  // editing points at the tool whose field has focus; null while the checkbox
  // list has focus.
  const [editing, setEditing] = useState<"gateway" | "mcp" | null>(null);

  const enabled = (key: ToolRowKey): boolean => {
    switch (key) {
      case "browser":
        return value.browser;
      case "gateway":
        return value.gatewayArn !== "";
      case "mcp":
        return value.mcpUrl !== "";
    }
  };

  const toggle = (key: ToolRowKey) => {
    switch (key) {
      case "browser":
        onChange({ ...value, browser: !value.browser });
        return;
      case "gateway":
        if (value.gatewayArn !== "") onChange({ ...value, gatewayArn: "" });
        else setEditing("gateway");
        return;
      case "mcp":
        if (value.mcpUrl !== "") onChange({ ...value, mcpUrl: "" });
        else setEditing("mcp");
        return;
    }
  };

  const editedRow = TOOL_ROWS.find((row) => row.key === editing);

  useInput((input, key) => {
    if (editing && editedRow?.field) {
      // The field's TextInput owns text editing; this handler only closes it.
      const valueKey = editedRow.field.valueKey;
      if (key.escape) {
        onChange({ ...value, [valueKey]: "" });
        setEditing(null);
        return;
      }
      if (key.return) {
        onChange({ ...value, [valueKey]: value[valueKey].trim() });
        setEditing(null);
      }
      return;
    }
    if (key.escape) {
      onBack();
      return;
    }
    if (key.upArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.downArrow) {
      setCursor((c) => Math.min(TOOL_ROWS.length - 1, c + 1));
      return;
    }
    if (input === " ") {
      toggle(TOOL_ROWS[cursor]!.key);
      return;
    }
    if (key.return) {
      onNext();
    }
  });

  const options: FormCheckboxOption[] = TOOL_ROWS.map((row) => ({
    label: row.label,
    checked: enabled(row.key),
    // A configured tool shows its value in place of the description.
    description:
      row.key === "gateway" && value.gatewayArn !== ""
        ? value.gatewayArn
        : row.key === "mcp" && value.mcpUrl !== ""
          ? value.mcpUrl
          : row.description,
  }));

  return (
    <Box flexDirection="column" paddingX={1}>
      <FormCheckboxMultiSelect
        name="choose tools"
        helpText="which tools should the agent be able to use?"
        options={options}
        cursorIndex={editing ? -1 : cursor}
      />
      {editing && editedRow?.field && (
        <FormTextInput
          name={editedRow.field.name}
          helpText={editedRow.field.helpText}
          placeholder={editedRow.field.placeholder}
          errorText=""
          value={value[editedRow.field.valueKey]}
          onChange={(next) => onChange({ ...value, [editedRow.field!.valueKey]: next })}
        />
      )}
      {editing && (
        <Text color={theme.colors.muted}>enter saves · esc or empty disables the tool</Text>
      )}
    </Box>
  );
}

// ─── step: prompt ─────────────────────────────────────────────────────────────

function PromptStep({
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
  // The FormTextArea owns text editing (typing, paste, backspace, newlines);
  // this handler owns the flow: esc goes back, ctrl+d continues, and enter
  // continues while the prompt is still empty (with content, enter is the
  // textarea's newline).
  useInput((input, key) => {
    if (key.escape) {
      onBack();
      return;
    }
    if (key.ctrl && input === "d") {
      onNext();
      return;
    }
    if (key.return && value === "") onNext();
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <FormTextArea
        name="system prompt"
        helpText="type or paste the agent's instructions · empty continues"
        placeholder="You are a helpful assistant…"
        value={value}
        onChange={onChange}
      />
      {value !== "" && (
        <Box
          borderStyle="single"
          borderColor={theme.colors.border}
          borderLeft={false}
          borderRight={false}
          borderBottom={false}
        >
          <Text color={theme.colors.muted}>{`${value.length} chars · ctrl+d continues`}</Text>
        </Box>
      )}
    </Box>
  );
}

// ─── step: review ─────────────────────────────────────────────────────────────

function ReviewStep({
  mode,
  request,
  onSubmit,
  onBack,
}: {
  mode: "create" | "update";
  request: unknown;
  onSubmit: () => void;
  onBack: () => void;
}) {
  const { columns } = useWindowSize();

  useInput((_input, key) => {
    if (key.escape) {
      onBack();
      return;
    }
    if (key.return) onSubmit();
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={theme.colors.text}>
        {mode === "create"
          ? "this request will be sent to CreateHarness"
          : "only the changed fields are sent to UpdateHarness"}
      </Text>
      {/* The step body is inset by paddingX on both sides. */}
      <Divider width={columns - 2} />
      <ScrollView>
        <CodeBlock
          language="json"
          showLineNumbers={false}
          showBorder={false}
          code={JSON.stringify(request, null, 2)}
        />
      </ScrollView>
    </Box>
  );
}

// ─── result panels ────────────────────────────────────────────────────────────

function SuccessPanel({
  mode,
  harnessId,
  version,
  arn,
  status,
  onContinue,
}: {
  mode: "create" | "update";
  harnessId: string;
  version?: string;
  status?: string;
  arn?: string;
  onContinue: () => void;
}) {
  useInput((_input, key) => {
    if (key.return || key.escape) onContinue();
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={theme.colors.success} bold>
        {glyphs.check} harness {mode === "create" ? "created" : "updated"}
      </Text>
      <Text color={theme.colors.muted}>
        {mode === "create"
          ? "  provisioning continues in the background · enter opens the harness"
          : "  the new version is deploying · enter opens the harness"}
      </Text>
      <Box
        borderStyle="single"
        borderColor={theme.colors.border}
        borderLeft={false}
        borderRight={false}
        borderBottom={false}
      >
        <KeyValueTable
          items={{
            id: harnessId,
            status: status ?? "",
            version: version?.toString() ?? "0",
            arn: arn ?? "",
          }}
        />
      </Box>
    </Box>
  );
}
