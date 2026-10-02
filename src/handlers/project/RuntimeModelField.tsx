import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { ScrollView, type ScrollViewRef } from "ink-scroll-view";
import { FormRadioGroup, type FormRadioOption } from "../../components/FormRadioGroup";
import { FormTextInput } from "../../components/FormTextInput";
import { darkTheme } from "../../components/ui/_core.js";
import { useKeyHints, useWizard } from "../../components/wizard";
import { isChinaRegion } from "../../core/partition";
import { SourceResolver } from "../../io";
import { DEFAULT_MODEL_IDS, type ModelProvider } from "../../projectSchemas/runtime";

const theme = darkTheme;

// The model step of the code-based runtime wizards: `agentcore create` with a
// runtime template and `agentcore add runtime`. Both hand the answer to
// resolveRuntimeTemplateShortcut as the same overrides the --model-provider,
// --model-id and --api-key flags supply, so the wizard scaffolds exactly what
// the flag command would. It is only shown for templates whose shortcut has
// supportsModelProviderOverride; the others stay Bedrock-only as before.

export interface RuntimeModelConfig {
  modelId: string;
  // The API key as the --api-key flag takes it: a 'file://<path>' source. The
  // secret itself is read at submit, never held in the form.
  apiKeySource: string;
}

// RuntimeModelValues keeps one config per provider, so switching providers and
// back does not lose what was typed for the first one.
export interface RuntimeModelValues {
  provider: ModelProvider;
  configs: Record<ModelProvider, RuntimeModelConfig>;
}

/** The answer as resolveRuntimeTemplateShortcut's overrides state it. */
export interface RuntimeModelOverrides {
  modelProvider: ModelProvider;
  modelId?: string;
  apiKeySource?: string;
}

const PROVIDER_OPTIONS: { provider: ModelProvider; label: string; description: string }[] = [
  {
    provider: "Bedrock",
    label: "bedrock",
    description: "an Amazon Bedrock model or inference profile, using the runtime's IAM role",
  },
  {
    provider: "Anthropic",
    label: "anthropic",
    description: "an Anthropic model using an API key",
  },
  {
    provider: "OpenAI",
    label: "openai",
    description: "an OpenAI model using an API key",
  },
  {
    provider: "Gemini",
    label: "gemini",
    description: "a Google Gemini model using an API key",
  },
  {
    provider: "LiteLLM",
    label: "litellm",
    description: "a third-party provider through LiteLLM (model id as <provider>/<model>)",
  },
];

// Amazon Bedrock, Anthropic, OpenAI, and Gemini cannot be called from China
// regions; LiteLLM can route to a provider that can. The create and add gates
// enforce this — the wizard only says so up front and starts on the one
// provider that can pass them.
const CHINA_BLOCKED_PROVIDERS: ReadonlySet<ModelProvider> = new Set([
  "Bedrock",
  "Anthropic",
  "OpenAI",
  "Gemini",
]);
const CHINA_BLOCKED_NOTE = "not accessible from China regions";
const CHINA_LITELLM_PLACEHOLDER = "deepseek/deepseek-chat";

const API_KEY_SOURCE_PATTERN = /^file:\/\/.+/;
const API_KEY_SOURCE_ERROR =
  "enter a file:// path to the key; inline secrets are not accepted here";

function inChina(region: string | undefined): boolean {
  return region !== undefined && isChinaRegion(region);
}

// emptyRuntimeModel starts on Bedrock with every provider's model id prefilled
// from the table the flag path defaults from. In a China region it starts on
// LiteLLM with no model id: the LiteLLM default routes to Amazon Bedrock, which
// the gate would refuse, so the user must name a reachable model.
export function emptyRuntimeModel(region?: string): RuntimeModelValues {
  const china = inChina(region);
  return {
    provider: china ? "LiteLLM" : "Bedrock",
    configs: Object.fromEntries(
      PROVIDER_OPTIONS.map(({ provider }) => [
        provider,
        {
          modelId: china && provider === "LiteLLM" ? "" : DEFAULT_MODEL_IDS[provider],
          apiKeySource: "",
        },
      ]),
    ) as Record<ModelProvider, RuntimeModelConfig>,
  };
}

function providerLabel(provider: ModelProvider): string {
  return PROVIDER_OPTIONS.find((candidate) => candidate.provider === provider)!.label;
}

function selectedConfig(values: RuntimeModelValues): RuntimeModelConfig {
  return values.configs[values.provider];
}

// toRuntimeModelOverrides is the answer as the flag path would state it: the
// model id only when it differs from the provider's default (so the wizard and
// a bare `--model-provider` produce the same ScaffoldRuntimeInput), the key
// source only when given.
export function toRuntimeModelOverrides(values: RuntimeModelValues): RuntimeModelOverrides {
  const config = selectedConfig(values);
  const modelId = config.modelId.trim();
  const apiKeySource = config.apiKeySource.trim();
  return {
    modelProvider: values.provider,
    ...(modelId !== "" && modelId !== DEFAULT_MODEL_IDS[values.provider] && { modelId }),
    ...(apiKeySource !== "" && { apiKeySource }),
  };
}

// resolveRuntimeModelApiKey reads the key the way the --api-key flag does,
// through the same SourceResolver. A screen has no stdin to offer, so only
// 'file://' sources resolve; '-' is refused with the resolver's own message.
export function resolveRuntimeModelApiKey(
  overrides: RuntimeModelOverrides,
): Promise<string | undefined> {
  return new SourceResolver({}).resolveSecret("api-key", overrides.apiKeySource);
}

// runtimeModelSummary is the review's account of the model: provider and id
// always, the key source only when one was given.
export function runtimeModelSummary(values: RuntimeModelValues): Record<string, string> {
  const config = selectedConfig(values);
  const overrides = toRuntimeModelOverrides(values);
  return {
    "model provider": providerLabel(values.provider),
    "model id": config.modelId.trim() || DEFAULT_MODEL_IDS[values.provider],
    ...(overrides.apiKeySource !== undefined && { "API key": overrides.apiKeySource }),
  };
}

// ─── the field ────────────────────────────────────────────────────────────────

type ModelFieldKey = keyof RuntimeModelConfig;

interface ModelField {
  key: ModelFieldKey;
  name: string;
  helpText: string;
  placeholder: string;
  required: boolean;
  requiredError: string;
  pattern?: RegExp;
  patternError?: string;
}

function modelFields(provider: ModelProvider, china: boolean): ModelField[] {
  const label = providerLabel(provider);
  const fields: ModelField[] = [
    {
      key: "modelId",
      name: "model ID",
      helpText:
        provider === "Bedrock"
          ? "a Bedrock model or inference profile ID"
          : provider === "LiteLLM"
            ? china
              ? "a LiteLLM model id (<provider>/<model>) reachable from China regions"
              : "a LiteLLM model id: <provider>/<model>"
            : `the ${label} model to use`,
      placeholder:
        provider === "LiteLLM" && china ? CHINA_LITELLM_PLACEHOLDER : DEFAULT_MODEL_IDS[provider],
      required: true,
      requiredError: `enter a model ID for ${label}`,
    },
  ];

  if (provider !== "Bedrock") {
    const optional = provider === "LiteLLM";
    fields.push({
      key: "apiKeySource",
      name: "API key file",
      helpText:
        (optional ? "optional · " : "") +
        `file://<path> of a file holding the ${label} API key · kept in agentcore/.env.local ` +
        "and provisioned as an AgentCore Identity credential on deploy",
      placeholder: optional ? "optional" : "file://./api-key.txt",
      required: !optional,
      requiredError: `enter the API key file for ${label}`,
      pattern: API_KEY_SOURCE_PATTERN,
      patternError: API_KEY_SOURCE_ERROR,
    });
  }

  return fields;
}

function fieldError(field: ModelField, value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return field.required ? field.requiredError : null;
  if (field.pattern && !field.pattern.test(trimmed)) return field.patternError ?? null;
  return null;
}

// RuntimeModelField is a compound field: one useInput over a provider list and
// the per-provider inputs the choice reveals. The wizard shell has no notion of
// focus, so the two levels are managed here — the provider list until enter,
// then the fields, with esc stepping back out. Same shape as HarnessModelField,
// which asks the config-based wizards' version of this question.
export function RuntimeModelField({
  value,
  onChange,
  region,
}: {
  value: RuntimeModelValues;
  onChange: (value: RuntimeModelValues) => void;
  /** The command's resolved region; a China region annotates the blocked providers. */
  region?: string;
}) {
  const { advance, back } = useWizard();
  const china = inChina(region);
  const providerIndex = PROVIDER_OPTIONS.findIndex((option) => option.provider === value.provider);
  const fields = modelFields(value.provider, china);
  const config = value.configs[value.provider];
  const [focusedField, setFocusedFieldState] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<ScrollViewRef>(null);
  // The offset when focus last moved, captured at key press while the layout
  // is settled. Scrolling is always measured from it rather than from the
  // live offset: newly revealed fields are measured before the viewport has
  // grown, so an adjustment made from a stale viewport height would otherwise
  // stick and push already visible fields around.
  const anchorOffsetRef = useRef(0);
  const setFocusedField = (next: number | null) => {
    anchorOffsetRef.current = next === null ? 0 : (scrollRef.current?.getScrollOffset() ?? 0);
    setFocusedFieldState(next);
  };

  const keepFocusedFieldVisible = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const position = scroll.getItemPosition(focusedField === null ? 0 : focusedField + 1);
    if (!position) return;
    const viewportHeight = scroll.getViewportHeight();
    const bottom = position.top + position.height;
    let target = anchorOffsetRef.current;
    if (position.top < target) target = position.top;
    else if (bottom > target + viewportHeight) {
      target = Math.min(position.top, bottom - viewportHeight);
    }
    if (target !== scroll.getScrollOffset()) scroll.scrollTo(target);
  }, [focusedField]);

  useLayoutEffect(() => {
    keepFocusedFieldVisible();
  }, [keepFocusedFieldVisible]);

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
          : Math.min(PROVIDER_OPTIONS.length - 1, providerIndex + 1);
        onChange({ ...value, provider: PROVIDER_OPTIONS[nextIndex]!.provider });
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
      const current = fieldError(field, config[field.key]);
      if (current !== null) {
        setError(current);
        return;
      }
      if (focusedField < fields.length - 1) {
        setFocusedField(focusedField + 1);
        return;
      }
      const missing = fields.findIndex(
        (candidate) => fieldError(candidate, config[candidate.key]) !== null,
      );
      if (missing >= 0) {
        setFocusedField(missing);
        setError(fieldError(fields[missing]!, config[fields[missing]!.key]));
        return;
      }
      advance();
    }
  });

  const options: FormRadioOption[] = PROVIDER_OPTIONS.map(({ provider, label, description }) => ({
    label,
    description:
      china && CHINA_BLOCKED_PROVIDERS.has(provider)
        ? `${description} · ${CHINA_BLOCKED_NOTE}`
        : description,
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
          helpText="choose a model provider"
          options={options}
          focusedIndex={focusedField === null ? providerIndex : undefined}
          selectedIndex={providerIndex}
        />
        {focusedField !== null &&
          fields.map((field, fieldIndex) => (
            <FormTextInput
              key={`${value.provider}.${field.key}`}
              name={field.name}
              helpText={field.helpText}
              placeholder={field.placeholder}
              pattern={field.pattern}
              errorText={field.patternError ?? ""}
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
