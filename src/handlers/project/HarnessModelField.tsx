import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { ScrollView, type ScrollViewRef } from "ink-scroll-view";
import type z from "zod";
import { FormRadioGroup, type FormRadioOption } from "../../components/FormRadioGroup";
import { FormTextInput } from "../../components/FormTextInput";
import { darkTheme } from "../../components/ui/_core.js";
import { useKeyHints, useWizard } from "../../components/wizard";
import {
  HARNESS_DEFAULT_MODEL_IDS,
  harnessModelIdHelp,
  type HarnessModelProvider,
  type HarnessModelSchema,
} from "../../projectSchemas/harness";

const theme = darkTheme;

// The model step every config-based harness wizard asks: `agentcore create`
// for a config-based project, `agentcore add harness` for a harness added to
// one. Both write the same HarnessModelSchema into the project spec, so they
// share the providers, the defaults, the revealed inputs, the messages and the
// review rows. A change here reaches both.

export interface HarnessModelConfig {
  modelId: string;
  apiKeyArn: string;
  apiBase: string;
}

// HarnessModelValues keeps one config per provider, so switching providers and
// back does not lose what was typed for the first one.
export interface HarnessModelValues {
  provider: HarnessModelProvider;
  configs: Record<HarnessModelProvider, HarnessModelConfig>;
}

export type HarnessModelInput = z.input<typeof HarnessModelSchema>;

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

// emptyHarnessModel starts on Bedrock with every provider's model ID prefilled
// from the same table the flag path defaults from.
export function emptyHarnessModel(): HarnessModelValues {
  return {
    provider: "bedrock",
    configs: Object.fromEntries(
      MODEL_PROVIDERS.map(({ provider }) => [
        provider,
        { modelId: HARNESS_DEFAULT_MODEL_IDS[provider], apiKeyArn: "", apiBase: "" },
      ]),
    ) as Record<HarnessModelProvider, HarnessModelConfig>,
  };
}

function providerLabel(provider: HarnessModelProvider): string {
  return MODEL_PROVIDERS.find((candidate) => candidate.provider === provider)!.label;
}

function selectedConfig(values: HarnessModelValues): HarnessModelConfig {
  return values.configs[values.provider];
}

// toHarnessModelInput is the answer as the flag path would state it: trimmed,
// the optional fields left out when blank, and the API base kept to the one
// provider that takes it. Both wizards run the result through
// HarnessSpecSchema, so they refuse what the flags refuse.
export function toHarnessModelInput(values: HarnessModelValues): HarnessModelInput {
  const config = selectedConfig(values);
  const apiBase = config.apiBase.trim();
  return {
    provider: values.provider,
    modelId: config.modelId.trim(),
    apiKeyArn: config.apiKeyArn.trim() || undefined,
    apiBase: values.provider === "lite_llm" && apiBase !== "" ? apiBase : undefined,
  };
}

// harnessModelSummary is the review's account of the model: provider and ID
// always, the credential and endpoint rows only when they were given.
export function harnessModelSummary(values: HarnessModelValues): Record<string, string> {
  const model = toHarnessModelInput(values);
  return {
    provider: providerLabel(values.provider),
    model: model.modelId,
    ...(model.apiKeyArn !== undefined && { "API key ARN": model.apiKeyArn }),
    ...(model.apiBase !== undefined && { "Custom API base URL": model.apiBase }),
  };
}

// ─── the field ────────────────────────────────────────────────────────────────

type ModelFieldKey = keyof HarnessModelConfig;

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
      helpText: harnessModelIdHelp(
        provider,
        provider === "bedrock"
          ? "a Bedrock model or inference profile ID"
          : `the ${providerLabel(provider)} model to use`,
      ),
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
      name: "Custom API base URL",
      helpText: "optional · leave blank to use the model provider's default endpoint",
      placeholder: "https://…",
      required: false,
      requiredError: "",
    });
  }

  return fields;
}

// HarnessModelField is a compound field: one useInput over a provider list and
// the per-provider inputs the choice reveals. The wizard shell has no notion of
// focus, so the two levels are managed here — the provider list until enter,
// then the fields, with esc stepping back out.
export function HarnessModelField({
  value,
  onChange,
}: {
  value: HarnessModelValues;
  onChange: (value: HarnessModelValues) => void;
}) {
  const { advance, back } = useWizard();
  const providerIndex = MODEL_PROVIDERS.findIndex((option) => option.provider === value.provider);
  const fields = modelFields(value.provider);
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
    const offset = scroll.getScrollOffset();
    const fitsAt = (at: number, rows: number) => position.top >= at && bottom <= at + rows;
    // Rows the field can count on after moving back up to `at`. When an input
    // line wraps and the content overflows by a row or two, the measured
    // viewport grows by exactly the offset scrolled; scrolling back would lose
    // those rows again, clip the field, scroll down, grow the viewport — and
    // so on until React gave up. Discounting the offset settles that after one
    // scroll, while a viewport that really grew (fields revealed before it was
    // measured) still re-anchors.
    const rowsAt = (at: number) => viewportHeight - Math.max(0, offset - at);
    const anchor = anchorOffsetRef.current;
    let target: number;
    if (position.top < anchor) target = position.top;
    else if (fitsAt(anchor, rowsAt(anchor))) target = anchor;
    else if (fitsAt(offset, viewportHeight)) target = offset;
    else target = Math.min(position.top, bottom - viewportHeight);
    // The viewport is only as tall as the content while everything fits (nothing
    // above constrains it), so a field appended below the list is measured
    // against a viewport that has not grown yet and looks out of view. Never
    // scroll past the bottom offset: when the content fits it is 0 and the list
    // stays put; when it really overflows the rule above still applies.
    const bottomOffset = Math.max(0, scroll.getContentHeight() - viewportHeight);
    target = Math.min(target, bottomOffset);
    if (target !== offset) scroll.scrollTo(target);
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
